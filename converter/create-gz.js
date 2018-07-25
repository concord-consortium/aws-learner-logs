// load environments variable defaults from .env
require('dotenv').config({path: '../.env'});
const awsConfig = require('../aws-config');

const fs = require('fs');
const walk = require('walk');
const zlib = require('zlib');
const path = require('path');
const mkdirp = require('mkdirp');
const AWS = require('aws-sdk');
const stream = require('stream');

const uploadStream = (s3Path) => {
  const s3 = new AWS.S3(awsConfig);
  const pass = new stream.PassThrough();
  return {
    writeStream: pass,
    promise: s3.upload({
      Bucket: process.env.S3_BUCKET,
      Key: s3Path,
      Body: pass,
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
    }).promise()
  };
};

const basePath = path.resolve('./processed-logs');
const basePathLength = basePath.length;
const walker = walk.walk(basePath, {});

let fileNumber = 0;
walker.on('file', (root, fileStats, next) => {
  if (path.extname(fileStats.name) !== '.json') {
    return next();
  }

  const s3Path = `processed-logs${root.substr(basePathLength).replace(/\\/g, '/')}/${fileStats.name.replace('.json', '')}.gz`;
  console.log(s3Path);

  const gzip = zlib.createGzip();
  const { writeStream, promise } = uploadStream(s3Path);
  const readStream = fs.createReadStream(path.resolve(root, fileStats.name));

  console.log(++fileNumber, root);
  readStream.pipe(gzip).pipe(writeStream);
  promise.then(next).catch(console.error);
});

walker.on("end", function () {
  console.log("all done");
});
