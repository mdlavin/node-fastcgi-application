var fcgi = require("fastcgi-stream"),
	fs = require("fs"),
	util = require("util"),
	net = require("net"),
	http = require("http");

var FCGI_LISTENSOCK_FILENO = process.stdin.fd;

var activeRequests = 0;

var closeConnection = function(socket) {
	socket.destroy();
	socket = null;
	activeRequests--;
}

var newRequestHandler = function(requestId, fastcgiStream, socket, server) {

	var req;
	var res;
	var params = [];
	
	return function(record) {
		if(record instanceof fcgi.records.BeginRequest) {
			req = new http.IncomingMessage(null)
		}
		
		else if(record instanceof fcgi.records.Params) {
			params = params.concat(record.params);
			
			if(record.params.length == 0) {
				var paramMap = {}
				
				params.forEach(function(paramPair) {
					var name = paramPair[0].toLowerCase();
					var value = paramPair[1];
					
					paramMap[name] = value;
					
					if (name.slice(0, 5) == 'http_') {
						var headerName = name.slice(5).replace('_', '-');
						req._addHeaderLine(headerName, value);
					}
					
				});

				// Fill in the request object.
				var httpVersionStr = paramMap["server_protocol"] || "HTTP/1.1";
				var httpVersionParts = httpVersionStr.replace(/^HTTP\//, "").split(".");
				if(httpVersionParts.length != 2) httpVersionParts = [1, 1];
				req.httpVersionMajor = httpVersionParts[0];
				req.httpVersionMinor = httpVersionParts[1];
				req.httpVersion = req.httpVersionMajor + "." + req.httpVersionMinor;

				req.url = paramMap["request_uri"];
				req.method = paramMap["request_method"];

				// Setup http response.
				res = new http.ServerResponse(req);
				
				var fakeSocket = {
					writable: true,
					write: function(data, encoding) {
						var stdOutRecord = new fcgi.records.StdOut(data);
						stdOutRecord.encoding = encoding;
						fastcgiStream.writeRecord(requestId, stdOutRecord);
					},
					on: function(eventName, callback) {
						if (eventName == 'close') {
							socket.on('close', callback);
						} else {
							console.error("http server requested a listener on the '" + eventName + "' event name that will be ignored");
						}
					},
					removeListener: function(eventName, callback) {
						if (eventName == 'close') {
							socket.removeListener('close', callback);
						} else {
							console.error("http server requested a listener be removed from the '" + eventName + "' event name but it will be ignored");
						}
					}
				};
				
				res.assignSocket(fakeSocket);
				
				// TODO: would be nice to support this, but it's causing weird
				// shit when sent over the FCGI wire.
				res.useChunkedEncodingByDefault = false;

				// Sorta hacky, we override the _storeHeader implementation of 
				// OutgoingMessage and blank out the http response header line.
				// Instead, we parse it out and put it into the Status http header.
				// TODO: should we check if we're supposed to be sending NPH or 
				// something? Can we even do that in FCGI?
				res._storeHeader = function(statusLine, headers) {
					var matches = statusLine.match(/^HTTP\/[0-9]\.[0-9] (.+)/);
					headers["Status"] = matches[1];
					http.OutgoingMessage.prototype._storeHeader.apply(this, ["", headers]);
				};
				
				res.on("finish", function() {		
					res.detachSocket(fakeSocket);					
					
					var end = new fcgi.records.EndRequest(0, fcgi.records.EndRequest.protocolStatus.REQUEST_COMPLETE);
					fastcgiStream.writeRecord(requestId, end);

					closeConnection(socket);
				});
				
				try {
					server.emit("request", req, res);
				}
				catch(e) {
					console.error(e);
					
					var end = new fcgi.records.EndRequest(-1, fcgi.records.EndRequest.protocolStatus.REQUEST_COMPLETE);
					fastcgiStream.writeRecord(requestId, end);
					closeConnection(socket);
				}
			}
		}

		else if(record instanceof fcgi.records.StdIn) {
			if(record.data.length == 0) {
				// Emit "end" on the IncomingMessage.
				req.emit("end");
			}
			else {
				req.emit("data", record.data);
			}
		}		
	}


}

// This is where the magic happens.
var handleConnection = function(socket, server) {
	socket.setNoDelay(true);
	var fastcgiStream = new fcgi.FastCGIStream(socket);
	
	activeRequests++;

	var requestHandlers = {};
	
	fastcgiStream.on("record", function(requestId, record) {
		
		var handler = requestHandlers[requestId];
		
		if(record instanceof fcgi.records.BeginRequest) {
			if(handler) {
				closeConnection(socket);
			}
			
			handler = newRequestHandler(requestId, fastcgiStream, socket, server); 

			requestHandlers[requestId] = handler;
		}
		
		else if(record instanceof fcgi.records.EndRequest) {
			if (handler) {
				delete requestHandlers[requestId];
			}
		}
	
		if (handler) {
			handler(record);
		}
	});
	
	// Let the games begin.
	socket.resume();
};

module.exports.handle = function(server) {
	var pipeServer = net.createServer();
	
	var initiateShutdown = function() {
		console.error("Initiating shutdown with " + activeRequests + " in progress");
		pipeServer.close(function() {
			console.error("Shutting down.");
			process.exit(0);
		});
	};
	
	pipeServer.listen({fd: FCGI_LISTENSOCK_FILENO}, function() {
		pipeServer.on('connection',function(socket) {
			handleConnection(socket, server);
		});
		
	});

	
	pipeServer.on('error', function(err) {
		console.error("Something bad happened: " + err);
	});
	
	process.on("SIGUSR1", initiateShutdown);
	process.on("SIGTERM", initiateShutdown);
};