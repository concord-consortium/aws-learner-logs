// create partition for new object

// read in object

// create application json files for each application

// load environments variable defaults from .env
require('dotenv').config({path: '../.env'});
const awsConfig = require('../aws-config');

const AWS = require('aws-sdk');
const zlib = require('zlib');
const async = require('async');
const uuid = require('uuid');

const s3 = new AWS.S3(awsConfig);
const athena = new AWS.Athena(awsConfig);

const zeroPad = (n) => n < 10 ? "0" + n : "" + n;
const now = new Date();
const todaysPrefix = `processed-logs/${zeroPad(now.getUTCFullYear())}/${zeroPad(now.getUTCMonth() + 1)}/${zeroPad(now.getUTCDate())}/`;

const NUM_PARALLEL_TRANSFORMS = 10;
const NUM_PARALLEL_UPLOADS = 10;

const listObjects = ({perObjectCallback}) => {
  const params = {
    Bucket: process.env.S3_BUCKET,
    Prefix: todaysPrefix,
    MaxKeys: 1000
  };
  s3.listObjectsV2(params, (err, data) => {
    if (err) {
      console.error(err);
    }
    else {
      async.eachLimit(data.Contents, NUM_PARALLEL_TRANSFORMS, (object, done) => {
        const params = {
          Bucket: process.env.S3_BUCKET,
          Key: object.Key
        };
        s3.getObject(params, (err, data) => {
          if (err) {
            return callback(err);
          }
          zlib.gunzip(data.Body, (err, body) => {
            if (err) {
              return callback(err);
            }
            perObjectCallback({object, body, done});
          });
        });
      }, console.log);
    }
  });
};

const forEachLogEntry = ({body, perLogEntryCallback}) => {
  body.toString().split('\n').forEach((line) => {
    if (line.length > 0) {
      perLogEntryCallback(JSON.parse(line));
    }
  });
};

const partitions = {};

listObjects({perObjectCallback: ({object, body, done}) => {

  //console.log(object);
  const [year, month, day, hour, ...rest] = object.Key.substr('processed-logs/'.length).split("/");
  const partition = `(year = '${year}', month = '${month}', day = '${day}', hour = '${hour}')`;
  if (!partitions[partition]) {
    partitions[partition] = true;

    console.log(partition);
    // create partition for object
    const queryParams = {
      QueryString: `ALTER TABLE processed_logs ADD IF NOT EXISTS PARTITION ${partition}`,
      ResultConfiguration: {
        OutputLocation: `s3://${process.env.ATHENA_OUTPUT_BUCKET}/${process.env.ATHENA_OUTPUT_FOLDER}/`
      },
      ClientRequestToken: uuid.v4(),
      QueryExecutionContext: {
        Database: process.env.GLUE_DATABASE
      }
    };
    athena.startQueryExecution(queryParams, (err, data) => {
      if (err) {
        console.error(err);
      }
      else {
        setInterval(() => {
          athena.getQueryExecution({QueryExecutionId: data.QueryExecutionId}, (err, data) => {
            if (err) {
              console.log(err);
            }
            else {
              console.log(data);
            }
          });
        }, 1000);
        console.log(data);
      }
    });
  }


  /*

  const applications = {};
  console.log(object.Key);
  forEachLogEntry({body, perLogEntryCallback: (entry) => {
    applications[entry.application] = applications[entry.application] || [];
    applications[entry.application].push(JSON.stringify(entry));
  }});

  async.eachOfLimit(applications, NUM_PARALLEL_UPLOADS, (lines, application, callback) => {
    zlib.gzip(lines.join('\n'), (err, gzipped) => {
      if (err) {
        return callback(err);
      }
      const applicationKey = object.Key.replace(/^processed-logs\//, `per-application-logs/${application.replace(/\//g, '').trim()}/`);
      s3.upload({
        Bucket: process.env.S3_BUCKET,
        Key: applicationKey,
        Body: gzipped,
        ContentType: 'application/json',
        ContentEncoding: 'gzip',
      }, callback);
    });
  }, done);
  */
}});
