// load environments variable defaults from .env
require('dotenv').config();
const awsConfig = require('../aws-config');

const AWS = require('aws-sdk');
const zlib = require('zlib');
const async = require('async');
const s3 = new AWS.S3(awsConfig);

const NUM_PARALLEL_TRANSFORMS = 10;
const NUM_PARALLEL_UPLOADS = 10;

const listObjects = ({startAfter, perObjectCallback}) => {
  const params = {
    Bucket: 'log-manager-data',
    Prefix: 'processed-logs/',
    MaxKeys: 1000
  };
  if (startAfter) {
    params.StartAfter = startAfter;
  }
  s3.listObjectsV2(params, (err, data) => {
    if (err) {
      console.error(err);
    }
    else {
      const lastKey = data.Contents.length > 0 ? data.Contents[data.Contents.length - 1].Key : null;
      async.eachLimit(data.Contents, NUM_PARALLEL_TRANSFORMS, (object, done) => {
        const params = {
          Bucket: 'log-manager-data',
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
      }, (err) => {
        if (err) {
          console.log(err);
        }
        else if (lastKey) {
          process.nextTick(() => {
            listObjects({startAfter: lastKey, perObjectCallback});
          });
        }
      });
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

listObjects({perObjectCallback: ({object, body, done}) => {
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
        Bucket: 'log-manager-data',
        Key: applicationKey,
        Body: gzipped,
        ContentType: 'application/json',
        ContentEncoding: 'gzip',
      }, callback);
    });
  }, done);
}});