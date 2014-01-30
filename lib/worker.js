'use strict';

var _ = require('lodash');

var fs      = require('fs'),
    util    = require('util'),
    url     = require('url'),
    http    = require('http'),
    https   = require('https'),
    crypto  = require("crypto"),    
    httpProxy = require('http-proxy'),

    cache         = require('./cache'),
    memoryMonitor = require('./memorymonitor'),
    versions      = require("./versions"),
    Server        = require('./server')

var errorMessage = Server.errorMessage

// Ignore SIGUSR
process.on('SIGUSR1', function () {});
process.on('SIGUSR2', function () {});


var formatRequest = function(req, res) {
  var socketBytesWritten = req.connection ? req.connection._bytesDispatched : 0;

  var requestInfo = {
    remoteAddr: req.headers['x-real-ip'],
    currentTime: res.timer.start,
    totalTimeSpent: (res.timer.end - res.timer.start),
    backendTimeSpent: (res.timer.end - res.timer.startBackend),
    method: req.method,
    url: req.url,
    httpVersion: req.httpVersion,
    statusCode: res.statusCode,
    socketBytesWritten: socketBytesWritten,
    referer: req.headers.referer,
    userAgent: req.headers['user-agent'],
    virtualHost: req.meta.virtualHost
  }
  return requestInfo
}


function Worker(config) {
  if (!(this instanceof Worker)) {
    return new Worker(config);
  }

  this.logger = config.logger
  this.cache  = cache(config)
  this.sni    = {}

  this.cache.getSNIConfig(this.updateSNI.bind(this));
  this.cache.watchSNIConfig(this.updateSNI.bind(this));

  this.logger.info("PID:", process.pid, "- Worker is starting")
  this.runServer(config.server);
}

Worker.prototype.updateSNI = function(rows) {
  var self = this
  if (rows) {
    var sni = this.sni = {};
    rows.forEach(function(sniConfig) {
      self.logger.info("Update sni of " + sniConfig.domain);

      sni[sniConfig.domain] = crypto.createCredentials(sniConfig).context;
    });
  }
}

Worker.prototype.runServer = function (config) {
  httpProxy.setMaxSockets(config.maxSockets);

  var self = this

  var sniCallback = function(domain) {
    return self.sni[domain];
  }

  var proxyErrorHandler = function (err, req, res) {
    if (err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' ||
        req.error !== undefined) {

      // This backend is dead
      var backendId = req.meta.backendId;

      if (req.meta.backendLen > 1) {
        this.cache.markDeadBackend(req.meta);
      }

      if (req.error) {
        err = req.error;
        // Clearing the error
        delete req.error;
      }

      self.logger.warn(req.headers.host + ': backend #' + backendId + ' is dead (' + JSON.stringify(err) + ') while handling request for ' + req.url);
    } else {
      self.logger.warn(req.headers.host + ': backend #' + req.meta.backendId + ' reported an error (' + JSON.stringify(err) + ') while handling request for ' + req.url);
    }

    req.retries = (req.retries === undefined) ? 0 : req.retries + 1;

    if (!res.connection || res.connection.destroyed === true) {
      // FIXME: When there is a TCP timeout, the socket of the Response
      // object is closed. Not possible to return a result after a retry.
      // BugID:5654
      self.logger.warn(req.headers.host + ': Response socket already closed, aborting.');
      try {
        return errorMessage(res, 'Cannot retry on error', 502);
      } catch (err) {
        // Even if the client socket is closed, we return an error
        // to force calling a res.end(). We do it safely in case there
        // is an error
        self.logger.warn(req.headers.host + ': Cannot end the request properly (' + err + ').');
      }
    }
    if (req.retries >= config.retryOnError) {
      if (config.retryOnError) {
        self.logger.warn(req.headers.host + ': Retry limit reached (' + config.retryOnError + '), aborting.');
        return errorMessage(res, 'Reached max retries limit', 502);
      }
      return errorMessage(res, 'Retry on error is disabled', 502);
    }
    req.emit('retry');
  }.bind(this);

  var startHandler = function (req, res) {

    var remoteAddr = Server.getRemoteAddress(req);

    // TCP timeout to 30 sec
    req.connection.setTimeout(config.tcpTimeout * 1000);

    // Make sure the listener won't be set again on retry
    if (req.connection.listeners('timeout').length < 2) {
      req.connection.once('timeout', function () {
        req.error = 'TCP timeout';
      });
    }

    // Set forwarded headers
    if (remoteAddr === null) {
      return errorMessage(res, 'Cannot read the remote address.');
    }
    if (remoteAddr.slice(0, 2) !== '::') {
      remoteAddr = '::ffff:' + remoteAddr;
    }

    // FIXME: replace by the real port instead of hardcoding it
    var proxy_defaults = {
      'x-forwarded-for': remoteAddr,
      'x-real-ip':       remoteAddr,
      'x-forwarded-protocol': req.connection.pair ? 'https' : 'http',
      'x-forwarded-proto':    req.connection.pair ? 'https' : 'http',
      'x-forwarded-port':     req.connection.pair ? '443' : '80'
    }

    req.headers = _.merge(req.headers, proxy_defaults)
  };

  var httpRequestHandler = function (req, res) {
    res.timer = {
      start: Date.now()
    };

    // Patch the response object
    (function () {
      // Enable debug?
      res.debug = (req.headers['x-debug'] !== undefined);
      // Patch the res.writeHead to detect backend HTTP errors and handle
      // debug headers
      var resWriteHead = res.writeHead;
      res.writeHead = function (statusCode) {
        if (res.sentHeaders === true) {
          // In case of errors when streaming the backend response,
          // we can resend the headers when raising an error.
          return;
        }
        res.sentHeaders = true;
        res.timer.end = Date.now();
        if (req.meta === undefined) {
          return resWriteHead.apply(res, arguments);
        }
        var markDeadBackend = function () {
          var backendId = req.meta.backendId;
          if (req.meta.backendLen > 1) {
            this.cache.markDeadBackend(req.meta);
          }
          self.logger.info(req.headers.host + ': backend #' + backendId + ' is dead (HTTP error code ' + statusCode + ') while handling request for ' + req.url);
        }.bind(this);

        // If the HTTP status code is 5xx, let's mark the backend as dead
        // We consider the 500 as critical errors only if the setting "deadBackendOn500" is enbaled
        // and only if the active health checks are running.
        var startErrorCode = (config.deadBackendOn500 === true &&
                              this.cache.passiveCheck === false) ? 500 : 501;
        if ((statusCode >= startErrorCode && statusCode < 600) && res.errorMessage !== true) {
          if (statusCode === 503) {
            var headers = arguments[arguments.length - 1];
            if (typeof headers === 'object') {
              // Let's lookup the headers to find a "Retry-After"
              // In this case, this is a legit maintenance mode
              if (headers['retry-after'] === undefined) {
                markDeadBackend();
              }
            }
          } else {
            // For all other cases, mark the backend as dead
            markDeadBackend();
          }
        }
        // If debug is enabled, let's inject the debug headers
        if (res.debug === true) {
          res.setHeader('x-debug-version-hipache', versions.hipache);
          res.setHeader('x-debug-backend-url', req.meta.backendUrl);
          res.setHeader('x-debug-backend-id', req.meta.backendId);
          res.setHeader('x-debug-vhost', req.meta.virtualHost);
          res.setHeader('x-debug-frontend-key', req.meta.frontend);
          res.setHeader('x-debug-time-total', (res.timer.end - res.timer.start));
          res.setHeader('x-debug-time-backend', (res.timer.end - res.timer.startBackend));
        }
        return resWriteHead.apply(res, arguments);
      }.bind(this);
      // Patch res.end to log the response stats
      var resEnd = res.end;
      res.end = function () {
        resEnd.apply(res, arguments);
        // Number of bytes written on the client socket
        var socketBytesWritten = req.connection ? req.connection._bytesDispatched : 0;
        if (req.meta === undefined ||
            req.headers['x-real-ip'] === undefined) {
          return; // Nothing to log
        }
        res.timer.end = Date.now();
        self.logger.info(formatRequest(req, res))
        //logRequest(req, res)
      };
    }.bind(this)());



    var redirect_to_backend = function(req, res) {
      var meta = req.meta
      var url_object = url.parse(meta.backendUrl)
      var blank_path = "/"

      res.writeHead(301, {
        'Location': req.meta.backendUrl
      });

      res.end();
      req.connection.destroy()
    }

    var should_redirect = function(req) {
      var meta = req.meta
      var url_object = url.parse(meta.backendUrl)
      var blank_path = "/"
      return url_object.path != blank_path
    }


    // Proxy the HTTP request
    var proxyRequest = function () {
      var buffer = httpProxy.buffer(req);

      this.cache.getBackendFromHostHeader(req.headers.host, function (err, code, backend) {
        if (err) {
          return errorMessage(res, err, code);
        }
        req.meta = {
          backendId: backend.id,
          backendLen: backend.len,
          frontend: backend.frontend,
          virtualHost: backend.virtualHost,
          backendUrl: backend.href
        };

        if (should_redirect(req)) {
          // just redirect to
          redirect_to_backend(req, res)
        } else {

          // Proxy the request to the backend
          res.timer.startBackend = Date.now();

          var proxy = new httpProxy.HttpProxy({
            target: {
              host: backend.hostname,
              port: backend.port
            },
            enable: {
              xforward: true
            }
          });
          proxy.on('proxyError', proxyErrorHandler);
          proxy.on('start', startHandler);
          proxy.proxyRequest(req, res, buffer);
        }
      });
    }.bind(this);

    if (config.retryOnError) {
      req.on('retry', function () {
        self.logger.info('Retrying on ' + req.headers.host);
        proxyRequest();
      });
    }

    proxyRequest();
  }.bind(this);

  var wsRequestHandler = function (req, socket, head) {
    var buffer = httpProxy.buffer(socket);

    this.cache.getBackendFromHostHeader(req.headers.host, function (err, code, backend) {
      var proxy;

      if (err) {
        self.logger.info('proxyWebSocketRequest: ' + err);
        return;
      }
      // Proxy the WebSocket request to the backend
      proxy = new httpProxy.HttpProxy({
        target: {
          host: backend.hostname,
          port: backend.port
        },
        source: {
          host: backend.hostname,
          port: backend.port
        }
      });
      proxy.proxyWebSocketRequest(req, socket, head, buffer);
    });
  }.bind(this);

  var monitor = memoryMonitor({
    logger: self.logger
  });

  // The handler configure the client socket for every new connection
  var tcpConnectionHandler = function (connection) {
    var remoteAddress = connection.remoteAddress,
    remotePort = connection.remotePort,
    start = Date.now();

    var getSocketInfo = function () {
      return JSON.stringify({
        remoteAddress: remoteAddress,
        remotePort: remotePort,
        bytesWritten: connection._bytesDispatched,
        bytesRead: connection.bytesRead,
        elapsed: (Date.now() - start) / 1000
      });
    };

    connection.setKeepAlive(false);
    connection.setTimeout(config.tcpTimeout * 1000);
    connection.on('error', function (error) {
      self.logger.info('TCP error from ' + getSocketInfo() + '; Error: ' + JSON.stringify(error));
    });
    connection.on('timeout', function () {
      self.logger.info('TCP timeout from ' + getSocketInfo());
      connection.destroy();
    });
  };

  if (config.httpKeepAlive !== true) {
    // Disable the http Agent of the http-proxy library so we force
    // the proxy to close the connection after each request to the backend
    httpProxy._getAgent = function () {
      return false;
    };
  }

  // Ipv4
  var ipv4HttpServer = http.createServer(httpRequestHandler);
  ipv4HttpServer.on('connection', tcpConnectionHandler);
  ipv4HttpServer.on('upgrade', wsRequestHandler);
  ipv4HttpServer.listen(config.port);

  monitor.addServer(ipv4HttpServer);

   //Ipv6
  var ipv6HttpServer = http.createServer(httpRequestHandler);
  ipv6HttpServer.on('connection', tcpConnectionHandler);
  ipv6HttpServer.on('upgrade', wsRequestHandler);
  ipv6HttpServer.listen(config.port, '::1');

  monitor.addServer(ipv6HttpServer);

  if (config.https) {
    var options = config.https;
    options.key = fs.readFileSync(options.key, 'utf8');
    options.cert = fs.readFileSync(options.cert, 'utf8');
    options.SNICallback = sniCallback;

    var ipv4HttpsServer = https.createServer(options, httpRequestHandler);
    ipv4HttpsServer.on('connection', tcpConnectionHandler);
    ipv4HttpsServer.on('upgrade', wsRequestHandler);
    ipv4HttpsServer.listen(config.https.port);

    var ipv6HttpsServer = https.createServer(options, httpRequestHandler);
    ipv6HttpsServer.on('connection', tcpConnectionHandler);
    ipv6HttpsServer.on('upgrade', wsRequestHandler);
    ipv6HttpsServer.listen(config.https.port, '::1');

    monitor.addServer(ipv4HttpsServer);
    monitor.addServer(ipv6HttpsServer);
  }
};

module.exports = Worker;
