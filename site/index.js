// load environments variable defaults from root .env
require('dotenv').config({path: '../.env'});
const awsConfig = require('../aws-config');

const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const AWS = require('aws-sdk');
const uuid = require('uuid');
const session = require('express-session');
const request = require('request');
const moment = require('moment-timezone');

app.set('view engine', 'pug');

app.use(express.static('public'));
app.use(bodyParser.json());

// add common error reponse
app.use((req, res, next) => {
  res.errorObject = (code, message, object) => {
    res.status(code);
    object.error = message;
    res.json(object);
  };
  res.error = (code, message) => {
    res.errorObject(code, message, {});
  };
  next();
});

// ensure oauth login
function  User(portalUserInfo) {
  this.info = portalUserInfo.extra || {};
  this.info.email = portalUserInfo.info.email;
  const roles = this.info.roles || [];
  this.isAdmin = Array.isArray(roles) ? roles.indexOf('admin') !== -1 : false;
}

const startOAuth = (req, res) => {
  req.session.state = uuid.v4();
  res.redirect(`${process.env.PORTAL_ROOT_URL}auth/concord_id/authorize?response_type=code&client_id=${process.env.PORTAL_AUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(`${process.env.SITE_ROOT_URL}oauth-callback`)}&state=${req.session.state}`);
};

app.use(session({
  secret: process.env.SITE_SESSION_SECRET,
  resave: false,
  saveUninitialized: true
}));

app.use((req, res, next) => {
  const isApiCall = /^\/api/.test(req.path);
  const apiNotAvailable = () => {
    res.errorObject(400, 'Not logged in', {
      reload: true
    });
  };

  if (/^\/(oauth|logout)/.test(req.path)) {
    next();
  }
  else {
    if (req.session.user) {
      if (req.session.user.isAdmin) {
        next();
      }
      else if (isApiCall) {
        apiNotAvailable();
      }
      else {
        res.status(400);
        res.send("Sorry, you have to be a portal admin to use this application.");
      }
    }
    else if (isApiCall) {
      apiNotAvailable();
    }
    else if (req.path !== '/') {
      startOAuth(req, res);
    }
    else {
      next();
    }
  }
});

app.get('/oauth-start', (req, res) => {
  startOAuth(req, res);
});

app.get('/oauth-callback', (req, res) => {
  if (req.query.state !== req.session.state) {
    return res.error('OAuth state parameter does not match!');
  }
  if (!req.query.code) {
    return res.error('Missing code parameter');
  }
  request.post(`${process.env.PORTAL_ROOT_URL}oauth/token`, {form: {
    grant_type: 'authorization_code',
    code: req.query.code,
    client_id: process.env.PORTAL_AUTH_CLIENT_ID,
    client_secret: process.env.PORTAL_AUTH_CLIENT_SECRET
  }}, (err, response, body) => {
    if (err) {
      return res.json(err);
    }
    try {
      const json = JSON.parse(body);
      if (json.error) {
        return res.error(response.statusCode, json.error);
      }
      req.session.accessToken = json.access_token;
      req.session.refreshToken = json.refresh_token;

      request.get(`${process.env.PORTAL_ROOT_URL}auth/concord_id/user.json`, {
        headers: {
          Authorization: `Bearer ${req.session.accessToken}`
        }
      }, (err, response, body) => {
        if (err) {
          return res.json(err);
        }
        try {
          req.session.user = new User(JSON.parse(body));
          res.redirect('/');
        }
        catch (e) {
          res.error(500, e.toString());
        }
      });
    }
    catch (e) {
      res.error(500, e.toString());
    }
  });
});

app.get('/', (req, res) => {
  res.render('index', {user: req.session.user, timezones: moment.tz.names()});
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => res.redirect('/'));
});

function ParsedTime(timeString, timezone) {
  // parse the time string with the timezone and then set the timezone
  moment.tz.setDefault(timezone);
  this.moment = moment(timeString).tz(timezone);
  this.date = this.moment.toDate();
  this.present = this.moment.isValid();
  this.timePresent = timeString.trim().indexOf(' ') !== -1;
}
const zeroPad = (n) => n < 10 ? "0" + n : "" + n;
ParsedTime.prototype.where = function (operator) {
  const parts = [
    `timestamp ${operator} ${this.moment.unix()}`,
    `year ${operator} '${this.date.getUTCFullYear()}'`,
    `month ${operator} '${zeroPad(this.date.getUTCMonth() + 1)}'`,
    `day ${operator} '${zeroPad(this.date.getUTCDate())}'`,
  ];
  if (this.timePresent) {
    parts.push(`hour ${operator} '${zeroPad(this.date.getUTCHours())}'`);
  }
  return parts.join(' AND ');
};

app.post('/api/query', (req, res) => {
  try {
    const json = JSON.parse(req.body.query);
    if (!json || !json.filter) {
      return res.error(400, 'Missing query filter section!');
    }
    const table = req.body.table || 'processed_logs';
    const timezone = req.body.timezone || 'America/New_York';

    const where = [];
    json.filter.forEach((filter) => {
      const key = filter.key;
      const list = filter.list || [];
      const remove = !!filter.remove;
      if (list.length > 0) {
        if (['session', 'username', 'application', 'activity', 'event'].indexOf(key) !== -1) {
          where.push(list.map((value) => `(${key} ${remove ? '!=' : '='} '${value.replace("'", "''")}')`).join(` ${remove ? 'AND' : 'OR'} `));
        }
        else if (key === 'run_remote_endpoint') {
          where.push(`run_remote_endpoint ${remove ? 'NOT IN' : 'IN'} (${list.map((value) => `'${value}'`).join(', ')})`);
        }
      }
      else if (key === 'time') {
        const startTime = new ParsedTime(filter.start_time, timezone);
        const endTime = new ParsedTime(filter.end_time, timezone);
        if (startTime.present && !endTime.present) {
          where.push(startTime.where('>='));
        }
        else if (!startTime.present && endTime.present) {
          where.push(endTime.where('<='));
        }
        else if (startTime.present && endTime.present) {
          where.push(`(${startTime.where('>=')}) AND (${endTime.where('<=')})`);
        }
      }
    });

    if (where.length === 0) {
      return res.error(400, 'Invalid query, no valid filters found!');
    }

    const sql = `SELECT * FROM "log_manager_data"."${table}" WHERE ${where.map((clause) => `(${clause})`).join(' AND ')}`;
    //return res.json({sql});

    const athena = new AWS.Athena(awsConfig);
    const queryParams = {
      QueryString: sql,
      ResultConfiguration: {
        OutputLocation: `s3://${process.env.ATHENA_OUTPUT_BUCKET}/${process.env.ATHENA_OUTPUT_FOLDER}/`
      },
      ClientRequestToken: uuid.v4(),
      QueryExecutionContext: {
        Database: 'log_manager_data'
      }
    };
    athena.startQueryExecution(queryParams, (err, data) => {
      if (err) {
        return res.errorObject(500, err.toString(), {sql});
      }
      res.json({
        result: data,
        sql: sql
      });
    });
  }
  catch (e) {
    res.error(500, e.toString());
  }
});

app.post('/api/cancelQuery', (req, res) => {
  if (!req.body.queryExecutionId) {
    return res.error(400, 'Missing queryExecutionId!');
  }

  const athena = new AWS.Athena(awsConfig);
  athena.stopQueryExecution({QueryExecutionId: req.body.queryExecutionId}, (err, data) => {
    if (err) {
      return res.error(500, err.toString());
    }
    res.json({success: true});
  });
});

app.get('/api/queryExecution', (req, res) => {
  if (!req.query.queryExecutionId) {
    return res.error(400, 'Missing queryExecutionId!');
  }

  const athena = new AWS.Athena(awsConfig);
  athena.getQueryExecution({QueryExecutionId: req.query.queryExecutionId}, (err, data) => {
    if (err) {
      return res.error(500, err.toString());
    }
    res.json({result: data});
  });
});

app.get('/api/downloadCSV', (req, res) => {
  if (!req.query.queryExecutionId) {
    return res.error(400, 'Missing queryExecutionId!');
  }

  res.setHeader('Content-disposition', `attachment; filename=${req.query.queryExecutionId}.csv`);

  const params = {
    Bucket: process.env.ATHENA_OUTPUT_BUCKET,
    Key: `${process.env.ATHENA_OUTPUT_FOLDER}/${req.query.queryExecutionId}.csv`
  };
  const s3 = new AWS.S3(awsConfig);
  s3.getObject(params).createReadStream().pipe(res);
});

const port = process.env.SITE_PORT || 5000;
app.listen(port, () => console.log(`Listening on port ${port}`));