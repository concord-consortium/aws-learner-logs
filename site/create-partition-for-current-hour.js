require('dotenv').config({path: '../.env'});
const awsConfig = require('../aws-config');

const AWS = require('aws-sdk');
const zlib = require('zlib');
const async = require('async');
const uuid = require('uuid');

const s3 = new AWS.S3(awsConfig);
const athena = new AWS.Athena(awsConfig);

module.exports = () => {
  const zeroPad = (n) => n < 10 ? "0" + n : "" + n;
  const now = new Date();
  const hourlyPrefix = `processed-logs/${zeroPad(now.getUTCFullYear())}/${zeroPad(now.getUTCMonth() + 1)}/${zeroPad(now.getUTCDate())}/${zeroPad(now.getUTCHours())}/`;

  const params = {
    Bucket: process.env.S3_BUCKET,
    Prefix: hourlyPrefix,
    MaxKeys: 1
  };
  console.log(params);
  s3.listObjectsV2(params, (err, data) => {
    console.log("data", data);
    if (err) {
      console.error(err);
    }
    else if (data.Contents.length > 0) {
      const object = data.Contents.pop();

      const [year, month, day, hour, ...rest] = object.Key.substr('processed-logs/'.length).split("/");
      const partition = `(year = '${year}', month = '${month}', day = '${day}', hour = '${hour}')`;
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
  });
};
