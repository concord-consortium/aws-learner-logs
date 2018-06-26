const fs = require('fs');
const walk = require('walk');
const path = require('path');
const mkdirp = require('mkdirp');

const walker = walk.walk("./processed-logs", {});

const dirs = [];

walker.on('directories', (root, dirStatsArray, next) => {
  dirStatsArray.forEach(dir => {
    if (dir.name.length === 1) {
      dirs.push(path.resolve(root, dir.name));
    }
  });
  next();
});

walker.on("end", function () {
  dirs.sort((a, b) => b.length - a.length);
  console.log(dirs);
  dirs.forEach(dir => {
    const parts = dir.split(path.sep);
    parts.push('0' + parts.pop());
    const paddedDir = parts.join(path.sep);
    console.log(paddedDir);
    fs.renameSync(dir, paddedDir);
  });
  console.log("all done");
});
