var fs    = require('fs'),
    path  = require('path'),
    util  = require('util'),
    cluster = require('cluster')

var master = require('../lib/master'),
    worker = require('../lib/worker')


function Hipache(config) {}

Hipache.prototype.run = function(path) {
  var config = this.readConfig(path)

  if (cluster.isMaster) {
    master(config);
    util.log('Server is running. ' + JSON.stringify(config.server));
  } else {
    worker(config);
  }
}

Hipache.prototype.readConfig = function(path) {
  var data    = fs.readFileSync(program.config),
      config  = JSON.parse(data);

  util.log('Loading config from ' + path);

  return config
}

module.exports = Hipache
