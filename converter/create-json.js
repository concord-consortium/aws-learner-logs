// load environments variable defaults from .env
require('dotenv').config({path: '../.env'});

const { Pool, Client } = require('pg');
const QueryStream = require('pg-query-stream');
const mkdirp = require('mkdirp');
const fs = require('fs');

const parseRubyHash = (rubyHashString) => {
  const result = {};
  const chars = rubyHashString.split("");
  let index = 0;
  let ch = chars[index];

  const readString = function () {
    if (ch !== '"') {
      return null;
    }
    const string = [];
    let prevCh = chars[index - 1];
    match('"');
    while ((index < chars.length) && (ch !== '"') && (prevCh !== '\\')) {
      string.push(ch);
      prevCh = ch;
      advance(1);
    }
    match('"');
    return string.join("");
  };
  const advance = function (n) {
    index += n;
    ch = chars[index];
  };
  const match = function (lexeme) {
    advance(lexeme.length);
  };

  while (index < chars.length) {
    const key = readString();
    match("=>");
    result[key] = readString();
    while ((index < chars.length) && (ch !== '"')) {
      advance(1);
    }
  }

  return result;
};

const zeroPad = (s) => {
  return ("" + s).length == 1 ? '0' + s : s;
};

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'log_manager',
  password: 'postgres',
  port: 5432,
});

pool.connect().then((client) => {
  console.log('QUERYING');
  const query = new QueryStream('SELECT * FROM LOGS');
  const stream = client.query(query);

  process.on("SIGINT", () => {
    pool.end();
    process.exit();
  });

  let rowNum = 0;
  let rowsToWrite = 0;

  stream.on('data', (row) => {
    // convert parameters and extras to json
    row.parameters = parseRubyHash(row.parameters);
    row.extras = parseRubyHash(row.extras);

    // move run_remote_endpoint out of extras
    if (row.extras.run_remote_endpoint) {
      row.run_remote_endpoint = row.extras.run_remote_endpoint;
      delete row.extras.run_remote_endpoint;
    }

    // convert time to unixtime and also save as timestamp
    const time = row.extras.localTime ? new Date(parseInt(row.extras.localTime)) : new Date(row.time);
    row.time = row.timestamp = Math.round(time.getTime() / 1000);

    // remove unneeded columns
    delete row.id;
    delete row.created_at;
    delete row.updated_at;

    row.parameters = JSON.stringify(row.parameters);
    row.extras = JSON.stringify(row.extras);

    // save to folder
    const year = time.getUTCFullYear();
    const month = zeroPad(time.getUTCMonth() + 1);
    const day = zeroPad(time.getUTCDate());
    const hour = zeroPad(time.getUTCHours());
    const dir = `./processed-logs/${year}/${month}/${day}/${hour}`;
    rowsToWrite++;
    mkdirp(dir, () => {
      const filename = `${dir}/log-manager-imported-${year}-${month}-${day}-${hour}.json`;
      fs.appendFileSync(filename, JSON.stringify(row) + '\n');
      if (rowsToWrite === 0) {
        process.exit();
      }
    });

    rowNum++;
    if (rowNum % 1000 === 0) {
      console.log(rowNum);
    }
  });
  stream.on('end', () => {
    pool.end();
  });
});
