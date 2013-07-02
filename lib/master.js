
'use strict';

var cluster = require('cluster'),
    events = require('events'),
    util = require('util'),
    accessLog = require("./access-log")

function Master(config) {
    if (!(this instanceof Master)) {
        return new Master(config);
    }

    accessLog = accessLog(this, config.server.accessLog);
    this.spawnWorkers(config.server.workers);
}

Master.prototype = new events.EventEmitter();

Master.prototype.spawnWorkers = function (number) {
    var spawnWorker = function () {
        var worker = cluster.fork();
        worker.on('message', function (message) {
            // Gather the logs from the workers
            if (message.type === 1) {
                // normal log
                util.log('(worker #' + message.from + ') ' + message.data);
            } else if (message.type === 2) {
                // access log
                accessLog(message.data);
            }
        });
    };

    // Spawn all workers
    for (var n = 0; n < number; n += 1) {
        util.log('Spawning worker #' + n);
        spawnWorker();
    }

    // When one worker is dead, let's respawn one
    cluster.on('exit', function (worker, code, signal) {
        var m = 'Worker died (pid: ' + worker.process.pid + ', suicide: ' +
                (worker.suicide === undefined ? 'false' : worker.suicide.toString());
        if (worker.suicide === false) {
            if (code !== null) {
                m += ', exitcode: ' + code;
            }
            if (signal !== null) {
                m += ', signal: ' + signal;
            }
        }
        m += '). Spawning a new one.';
        util.log(m);
        spawnWorker();
    });

    // Set an exit handler
    var onExit = function () {
        this.emit('exit');
        util.log('Exiting, killing the workers');
        for (var id in cluster.workers) {
            var worker = cluster.workers[id];
            util.log('Killing worker #' + worker.process.pid);
            worker.destroy();
        }
        process.exit(0);
    }.bind(this);
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);
};

module.exports = Master;
