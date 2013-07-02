var fs = require('fs')

var accessLog = function (self, path) {
    var months = [
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul',  'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ];
    var openStream = function () {
        return fs.createWriteStream(path, {
            flags: 'a+',
            mode: 0x1A4 // 0644
        });
    };
    var stream = openStream();

    process.on('SIGUSR1', function () {
        // Reload the Stream on signal
        util.log('Caught a SIGUSR1 signal, reopening the log file.');
        stream.end();
        stream = openStream();
    });
    self.on('exit', function () {
        stream.end();
    });

    // Format log
    return function (data) {
        var line = '',
            date = new Date(data.currentTime);
        var addDigit = function (n) {
            if (n < 10) {
                return '0' + n;
            }
            return n;
        };
        // Remote addr
        if (data.remoteAddr.slice(0, 2) !== '::') {
            line += '::ffff:';
        }
        line += data.remoteAddr;
        // Empty
        line += ' - - ';
        // Date
        line += '[';
        line += addDigit(date.getUTCDate());
        line += '/';
        line += months[date.getUTCMonth()];
        line += '/';
        line += date.getFullYear();
        line += ':';
        line += addDigit(date.getUTCHours());
        line += ':';
        line += addDigit(date.getUTCMinutes());
        line += ':';
        line += addDigit(date.getUTCSeconds());
        line += ' +0000] "';
        // Request
        line += data.method;
        line += ' ';
        line += data.url;
        line += ' HTTP/';
        line += data.httpVersion;
        line += '" ';
        // Status code
        line += data.statusCode;
        line += ' ';
        // Bytes sent
        //FIXME, sometimes we cannot read socketBytesWritten (maybe because of a websocket?)
        line += data.socketBytesWritten || 0;
        line += ' "';
        // Referer
        line += data.referer || '';
        line += '" "';
        // User-Agent
        line += data.userAgent || '';
        line += '" "';
        // Virtual host
        line += data.virtualHost;
        line += '" ';
        // Total time spent
        line += (data.totalTimeSpent / 1000);
        line += ' ';
        // Backend time spent
        line += (data.backendTimeSpent / 1000);
        stream.write(line + '\n');
    };
};


module.exports = accessLog;
