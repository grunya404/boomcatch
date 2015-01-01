// Copyright © 2014 Nature Publishing Group
//
// This file is part of boomcatch.
//
// Boomcatch is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Boomcatch is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with boomcatch. If not, see <http://www.gnu.org/licenses/>.

/*globals require, exports, process, setTimeout */

'use strict';

var check = require('check-types'),
    http = require('http'),
    url = require('url'),
    qs = require('qs'),
    fs = require('fs'),
    toobusy = require('toobusy-js'),
    cluster = require('cluster'),

defaults = {
    host: '0.0.0.0',
    port: 80,
    path: '/beacon',
    referer: /.*/,
    origin: '*',
    limit: 0,
    maxSize: -1,
    log: {
        info: function () {},
        warn: function () {},
        error: function () {}
    },
    validator: 'permissive',
    filter: 'unfiltered',
    mapper: 'statsd',
    forwarder: 'udp',
    workers: 0,
    delayRespawn: 0,
    maxRespawn: -1
},

signals, normalisationMaps;

/**
 * Public function `listen`.
 *
 * Forwards performance metrics calculated from Boomerang beacon requests.
 *
 * @option host {string}         HTTP host name to accept connections on. Defaults to
 *                               '0.0.0.0' (INADDR_ANY).
 * @option port {number}         HTTP port to accept connections on. Defaults to 80.
 * @option path {string}         URL path to accept requests to. Defaults to '/beacon'.
 * @option referer {regexp}      HTTP referers to accept requests from. Defaults to `.*`.
 * @option origin {string|array} URL(s) for the Access-Control-Allow-Origin header.
 * @option limit {number}        Minimum elapsed time between requests from the same IP
 *                               address. Defaults to 0.
 * @option maxSize {number}      Maximum body size for POST requests.
 * @option log {object}          Object with `info` and `error` log functions.
 * @option validator {string}    Validator used to accept or reject beacon requests,
 *                               loaded with `require`. Defaults to 'permissive'.
 * @option filter {string}       Filter used to purge unwanted data, loaded with `require`.
 *                               Defaults to `unfiltered`.
 * @option mapper {string}       Data mapper used to transform data before forwarding,
 *                               loaded with `require`. Defaults to 'statsd'.
 * @option prefix {string}       Prefix to use for mapped metric names. Defaults to ''.
 * @option svgTemplate {string}  Path to alternative SVG handlebars template file (SVG mapper only).
 * @option svgSettings {string}  Path to alternative SVG settings JSON file (SVG mapper only).
 * @option forwarder {string}    Forwarder used to send data, loaded with `require`.
 *                               Defaults to 'udp'.
 * @option fwdHost {string}      Host name to forward mapped data to (UDP only).
 * @option fwdPort {number}      Port to forward mapped data on (UDP only).
 * @option fwdSize {bytes}       Maximum allowable packet size for data forwarding (UDP only).
 * @option fwdUrl {string}       URL to forward mapped data to (HTTP only).
 * @option fwdMethod {string}    Method to forward mapped data with (HTTP only).
 * @option fwdDir {string}       Directory to write mapped data to (file forwarder only).
 * @option workers {number}      Number of child worker processes to fork. Defaults to 0.
 * @option delayRespawn {number} Number of milliseconds to delay respawning. Defaults to 0.
 * @option maxRespawn {number}   Maximum number of respawn attempts. Defaults to -1.
 */
exports.listen = function (options) {
    var workers, log;

    if (options) {
        verifyOptions(options);
    } else {
        options = {};
    }

    workers = getWorkers(options);
    log = getLog(options);

    createExceptionHandler(log);

    if (cluster.isMaster) {
        log.info('starting boomcatch in process ' + process.pid + ' with options:\n' + JSON.stringify(options, null, '    '));

        createSignalHandlers(log);

        if (workers > 0) {
            return createWorkers(workers, options, log);
        }
    }

    createServer(options, log);
};

function verifyOptions (options) {
    check.assert.maybe.unemptyString(options.host, 'Invalid host');
    check.assert.maybe.positive(options.port, 'Invalid port');
    check.assert.maybe.unemptyString(options.path, 'Invalid path');
    check.assert.maybe.instance(options.referer, RegExp, 'Invalid referer');
    check.assert.maybe.positive(options.limit, 'Invalid limit');
    check.assert.maybe.positive(options.maxSize, 'Invalid max size');
    check.assert.maybe.unemptyString(options.validator, 'Invalid validator');
    check.assert.maybe.unemptyString(options.filter, 'Invalid filter');
    check.assert.maybe.number(options.workers, 'Invalid workers');
    check.assert.not.negative(options.workers, 'Invalid workers');
    check.assert.maybe.number(options.delayRespawn, 'Invalid worker respawn delay');
    check.assert.not.negative(options.delayRespawn, 'Invalid worker respawn delay');
    check.assert.maybe.number(options.maxRespawn, 'Invalid worker respawn limit');

    verifyOrigin(options.origin);
    verifyLog(options.log);

    verifyMapperOptions(options);
    verifyForwarderOptions(options);

    check.assert.maybe.unemptyString(options.key, 'Invalid key');
    check.assert.maybe.unemptyString(options.cert, 'Invalid cert');

    // At a minimum, key and cert are required for secure connection
    if (check.unemptyString(options.key) && check.unemptyString(options.cert)) {
        options.https = 1;
    } else {
        options.https = 0;
    }

    check.assert.maybe.unemptyString(options.pfx, 'Invalid pfx');
    check.assert.maybe.unemptyString(options.passphrase, 'Invalid passphrase');
    check.assert.maybe.array(options.ca, 'Invalid ca');
    check.assert.maybe.array(options.crl, 'Invalid crl');
    check.assert.maybe.unemptyString(options.ciphers, 'Invalid ciphers');
    check.assert.maybe.number(options.handshakeTimeout, 'Invalid handshakeTimeout');
    check.assert.not.negative(options.handshakeTimeout, 'Invalid handshakeTimeout');
    check.assert.maybe.number(options.honorCipherOrder, 'Invalid honorCipherOrder');
    check.assert.maybe.number(options.requestCert, 'Invalid requestCert');
    check.assert.maybe.number(options.rejectUnauthorized, 'Invalid rejectUnauthorized');
    check.assert.maybe.array(options.NPNProtocols, 'Invalid NPNProtocols');
    check.assert.maybe.function(options.SNICallback, 'Invalid SNICallback');
    check.assert.maybe.unemptyString(options.sessionIdContext, 'Invalid sessionIdContext');
    check.assert.maybe.unemptyString(options.secureProtocol, 'Invalid secureProtocol');
}

function verifyOrigin (origin) {
    if (check.string(origin)) {
        if (origin !== '*' && origin !== 'null') {
            check.assert.webUrl(origin, 'Invalid access control origin');
        }
    } else if (check.array(origin)) {
        origin.forEach(function (o) {
            check.assert.webUrl(o, 'Invalid access control origin');
        });
    } else if (origin) {
        throw new Error('Invalid access control origin');
    }
}

function verifyLog (log) {
    check.assert.maybe.object(log, 'Invalid log object');

    if (check.object(log)) {
        check.assert.function(log.info, 'Invalid log.info function');
        check.assert.function(log.warn, 'Invalid log.warn function');
        check.assert.function(log.error, 'Invalid log.error function');
    }
}

function verifyMapperOptions (options) {
    check.assert.maybe.unemptyString(options.mapper, 'Invalid data mapper');
    check.assert.maybe.unemptyString(options.prefix, 'Invalid metric prefix');
}

function verifyForwarderOptions (options) {
    check.assert.maybe.unemptyString(options.forwarder, 'Invalid forwarder');

    switch (options.forwarder) {
        case 'waterfall-svg':
            verifyFile(options.svgTemplate, 'Invalid SVG template path');
            verifyFile(options.svgSettings, 'Invalid SVG settings path');
            break;
        case 'file':
            verifyDirectory(options.fwdDir, 'Invalid forwarding directory');
            break;
        case 'http':
            check.assert.webUrl(options.fwdUrl, 'Invalid forwarding URL');
            check.assert.maybe.unemptyString(options.fwdMethod, 'Invalid forwarding method');
            break;
        default:
            check.assert.maybe.unemptyString(options.fwdHost, 'Invalid forwarding host');
            check.assert.maybe.positive(options.fwdPort, 'Invalid forwarding port');
            check.assert.maybe.positive(options.fwdSize, 'Invalid forwarding packet size');
    }
}

function verifyFile (path, message) {
    verifyFs(true, path, 'isFile', message);
}

function verifyFs (isOptional, path, method, message) {
    var stat;

    if (isOptional && !path) {
        return;
    }

    check.assert.unemptyString(path, message);

    if (fs.existsSync(path)) {
        stat = fs.statSync(path);

        if (stat[method]()) {
            return;
        }
    }

    throw new Error(message);
}

function verifyDirectory (path, message) {
    verifyFs(false, path, 'isDirectory', message);
}

function getWorkers (options) {
    return getOption('workers', options);
}

function getOption (name, options) {
    return options[name] || defaults[name];
}

function getLog (options) {
    return getOption('log', options);
}

function createExceptionHandler (log) {
    process.on('uncaughtException', handleException.bind(null, log));
}

function handleException (log, error) {
    log.error('unhandled exception\n' + error.stack);
    process.exit(1);
}

function createSignalHandlers (log) {
    signals.forEach(function (signal) {
        process.on(signal.name, handleTerminalSignal.bind(null, log, signal.name, signal.value));
    });
}

signals = [
    { name: 'SIGHUP', value: 1 },
    { name: 'SIGINT', value: 2 },
    { name: 'SIGTERM', value: 15 }
];

function handleTerminalSignal (log, signal, value) {
    log.info(signal + ' received, terminating process ' + process.pid);
    process.exit(128 + value);
}

function createWorkers (count, options, log) {
    var respawnCount, respawnLimit, respawnDelay, i;

    respawnCount = 0;
    respawnLimit = getOption('maxRespawn', options);
    respawnDelay = getOption('delayRespawn', options);

    cluster.on('online', function (worker) {
        log.info('worker ' + worker.process.pid + ' started');
    });

    cluster.on('exit', function (worker, code, signal) {
        var exitStatus = getExitStatus(code, signal);

        if (worker.suicide) {
            return log.info('worker ' + worker.process.pid + ' exited (' + exitStatus + ')');
        }

        respawnCount += 1;

        if (respawnLimit > 0 && respawnCount > respawnLimit) {
            return log.error('exceeded respawn limit, worker ' + worker.process.pid + ' died (' + exitStatus + ')');
        }

        setTimeout(function () {
            log.warn('worker ' + worker.process.pid + ' died (' + exitStatus + '), respawning');
            cluster.fork();
        }, respawnDelay);
    });

    for (i = 0; i < count; i += 1) {
        cluster.fork();
    }
}

function getExitStatus (code, signal) {
    if (check.assigned(signal)) {
        return 'signal ' + signal;
    }

    return 'code ' + code;
}

function createServer (options, log) {
    var host, port, path, request, httpsOptions, server;

    host = getHost(options);
    port = getPort(options);
    path = getPath(options);

    log.info('listening for ' + host + ':' + port + path);

    request = handleRequest.bind(
        null,
        log,
        path,
        getReferer(options),
        getLimit(options),
        getOrigin(options),
        getMaxSize(options),
        getValidator(options),
        getFilter(options),
        getMapper(options),
        getForwarder(options)
    );

    if (options.https === 1) {
        httpsOptions = {
            key: fs.readFileSync(options.key),
            cert: fs.readFileSync(options.cert)
        };

        server = https.createServer(httpsOptions, request);
    } else {
        server = http.createServer(request);
    }

    server.listen(port, host);
}

function getHost (options) {
    return getOption('host', options);
}

function getPort (options) {
    return getOption('port', options);
}

function getPath (options) {
    return getOption('path', options);
}

function getReferer (options) {
    return getOption('referer', options);
}

function getLimit (options) {
    var limit = getOption('limit', options);

    if (limit === 0) {
        return null;
    }

    return {
        time: limit,
        requests: {}
    };
}

function getOrigin (options) {
    return getOption('origin', options);
}

function getMaxSize (options) {
    return getOption('maxSize', options);
}

function getValidator (options) {
    return getExtension('validator', options);
}

function getExtension (type, options, properties) {
    var name, extension, result;

    name = getOption(type, options);

    try {
        extension = require('./' + type + 's/' + name);
    } catch (e) {
        extension = require(name);
    }

    result = extension.initialise(options);

    if (check.array(properties)) {
        properties.forEach(function (property) {
            result[property] = extension[property];
        });
    }

    return result;
}

function getFilter (options) {
    return getExtension('filter', options);
}

function getMapper (options) {
    return getExtension('mapper', options, ['type','separator']);
}

function getForwarder (options) {
    return getExtension('forwarder', options);
}

function handleRequest (log, path, referer, limit, origin, maxSize, validator, filter, mapper, forwarder, request, response) {
    var requestPath, remoteAddress, state;

    logRequest(log, request);

    if (toobusy()) {
        return fail(log, request, response, 503, 'Server too busy');
    }

    requestPath = getRequestPath(request);
    remoteAddress = getRemoteAddress(request);

    if (!checkRequest(log, path, referer, limit, requestPath, remoteAddress, request, response)) {
        return;
    }

    response.setHeader('Access-Control-Allow-Origin', getAccessControlOrigin(request.headers, origin));

    state = {
        body: ''
    };

    request.on('data', receive.bind(null, log, state, maxSize, request, response));
    request.on('end', send.bind(null, log, state, remoteAddress, validator, filter, mapper, forwarder, request, response));
}

function logRequest (log, request) {
    log.info(
        'referer=' + (request.headers.referer || '') + ' ' +
        'user-agent=' + request.headers['user-agent'] + ' ' +
        'address=' + request.socket.remoteAddress + '[' + (request.headers['x-forwarded-for'] || '') + ']' + ' ' +
        'method=' + request.method + ' ' +
        'url=' + request.url
    );
}

function getRequestPath (request) {
    var queryIndex = request.url.indexOf('?');

    return queryIndex === -1 ? request.url : request.url.substr(0, queryIndex);
}

function getRemoteAddress (request) {
    var proxiedAddresses = request.headers['x-forwarded-for'], filteredAddresses;

    if (proxiedAddresses) {
        filteredAddresses = proxiedAddresses.split(',').map(function (address) {
            return address.trim();
        }).filter(check.unemptyString);

        if (filteredAddresses.length > 0) {
            return filteredAddresses[0];
        }
    }

    return request.socket.remoteAddress;
}

function checkRequest (log, path, referer, limit, requestPath, remoteAddress, request, response) {
    if (request.method !== 'GET' && request.method !== 'POST') {
        fail(log, request, response, 405, 'Invalid method `' + request.method + '`');
        return false;
    }

    if (requestPath !== path) {
        fail(log, request, response, 404, 'Invalid path `' + requestPath + '`');
        return false;
    }

    if (check.unemptyString(request.headers.referer) && !referer.test(request.headers.referer)) {
        fail(log, request, response, 403, 'Invalid referer `' + request.headers.referer + '`');
        return false;
    }

    if (request.method === 'POST' && !isValidContentType(request.headers['content-type'])) {
        fail(log, request, response, 415, 'Invalid content type `' + request.headers['content-type'] + '`');
        return false;
    }

    if (!checkLimit(limit, remoteAddress)) {
        fail(log, request, response, 429, 'Exceeded rate `' + limit.time + '`');
        return false;
    }

    return true;
}

function fail (log, request, response, status, message) {
    log.error(status + ' ' + message);

    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.end('{ "error": "' + message + '" }');
    request.socket.destroy();
}

function isValidContentType (contentType) {
    if (!contentType) {
        return false;
    }

    if (contentType === 'application/x-www-form-urlencoded' || contentType === 'text/plain') {
        return true;
    }

    return isValidContentType(contentType.substr(0, contentType.indexOf(';')));
}

function checkLimit (limit, remoteAddress) {
    var now, lastRequest;

    if (limit === null) {
        return true;
    }

    now = Date.now();
    lastRequest = limit.requests[remoteAddress];

    if (check.positive(lastRequest) && now <= lastRequest + limit.time) {
        return false;
    }

    limit.requests[remoteAddress] = now;

    return true;
}

function getAccessControlOrigin (headers, origin) {
    if (check.array(origin)) {
        if (headers.origin && contains(origin, headers.origin)) {
            return headers.origin;
        }

        return 'null';
    }

    return origin;
}

function contains (array, value) {
    return array.reduce(function (match, candidate) {
        return match || candidate === value;
    }, false);
}

function receive (log, state, maxSize, request, response, data) {
    if (
        (request.method === 'GET' && data.length > 0) ||
        (request.method === 'POST' && maxSize >= 0 && state.body.length + data.length > maxSize)
    ) {
        state.failed = true;
        return fail(log, request, response, 413, 'Body too large');
    }

    state.body += data;
}

function send (log, state, remoteAddress, validator, filter, mapper, forwarder, request, response) {
    var data, referer, userAgent, mappedData;

    if (state.failed) {
        return;
    }

    try {
        data = parseData(request, state);
        referer = request.headers.referer;
        userAgent = request.headers['user-agent'];

        if (!validator(data, referer, userAgent, remoteAddress)) {
            throw null;
        }

        mappedData = mapper(filter(normaliseData(data)), referer, userAgent, remoteAddress);
        if (mappedData === '') {
            return pass(log, response, 204, 0);
        }

        log.info('sending ' + mappedData);

        forwarder(mappedData, mapper.type, mapper.separator, function (error, bytesSent) {
            if (error) {
                return fail(log, request, response, 502, error);
            }

            pass(log, response, state.successStatus, bytesSent);
        });
    } catch (error) {
        fail(log, request, response, 400, 'Invalid data');
    }
}

function parseData (request, state) {
    if (request.method === 'GET') {
        state.successStatus = 204;
        return qs.parse(url.parse(request.url).query);
    }

    state.successStatus = 200;

    if (state.body.substr(0, 5) === 'data=') {
        state.body = state.body.substr(5);
    }

    state.body = decodeURIComponent(state.body);

    if (request.headers['content-type'] === 'text/plain') {
        return JSON.parse(state.body);
    }

    return qs.parse(state.body);
}

function normaliseData (data) {
    // TODO: Add metadata for URL, browser, geolocation
    return {
        rt: normaliseRtData(data),
        navtiming: normaliseNavtimingData(data),
        restiming: normaliseRestimingData(data)
    };
}

function normaliseRtData (data) {
    /*jshint camelcase:false */

    var start, timeToFirstByte, timeToLastByte, timeToLoad;

    start = getOptionalDatum(data, 'rt.tstart');
    timeToFirstByte = getOptionalDatum(data, 't_resp');
    timeToLastByte = getOptionalSum(data, 't_resp', 't_page');
    timeToLoad = getOptionalDatum(data, 't_done');

    check.assert.maybe.positive(start);
    check.assert.maybe.positive(timeToFirstByte);
    check.assert.maybe.positive(timeToLastByte);
    check.assert.maybe.positive(timeToLoad);

    if (check.positive(timeToFirstByte) || check.positive(timeToLastByte) || check.positive(timeToLoad)) {
        return {
            timestamps: {
                start: start
            },
            events: {},
            durations: {
                firstbyte: timeToFirstByte,
                lastbyte: timeToLastByte,
                load: timeToLoad
            },
            url: data.r
        };
    }
}

function getOptionalDatum (data, key) {
    if (data[key]) {
        return parseInt(data[key]);
    }
}

function getOptionalSum (data, aKey, bKey) {
    if (data[aKey] && data[bKey]) {
        return parseInt(data[aKey]) + parseInt(data[bKey]);
    }
}

function normaliseNavtimingData (data) {
    /*jshint camelcase:false */
    var result = normaliseCategory(normalisationMaps.navtiming, data, 'nt_nav_st');

    if (result) {
        result.type = data.nt_nav_type;
    }

    return result;
}

normalisationMaps = {
    navtiming: {
        timestamps: [
            { key: 'nt_nav_st', name: 'start' },
            { key: 'nt_fet_st', name: 'fetchStart' },
            { key: 'nt_ssl_st', name: 'sslStart', optional: true },
            { key: 'nt_req_st', name: 'requestStart' },
            { key: 'nt_domint', name: 'domInteractive' }
        ],
        events: [
            { start: 'nt_unload_st', end: 'nt_unload_end', name: 'unload' },
            { start: 'nt_red_st', end: 'nt_red_end', name: 'redirect' },
            { start: 'nt_dns_st', end: 'nt_dns_end', name: 'dns' },
            { start: 'nt_con_st', end: 'nt_con_end', name: 'connect' },
            { start: 'nt_res_st', end: 'nt_res_end', name: 'response' },
            { start: 'nt_domloading', end: 'nt_domcomp', name: 'dom' },
            { start: 'nt_domcontloaded_st', end: 'nt_domcontloaded_end', name: 'domContent' },
            { start: 'nt_load_st', end: 'nt_load_end', name: 'load' }
        ],
        durations: []
    },
    restiming: {
        timestamps: [
            { key: 'rt_st', name: 'start' },
            { key: 'rt_fet_st', name: 'fetchStart' },
            { key: 'rt_scon_st', name: 'sslStart', optional: true },
            { key: 'rt_req_st', name: 'requestStart', optional: true }
        ],
        events: [
            { start: 'rt_red_st', end: 'rt_red_end', name: 'redirect', optional: true },
            { start: 'rt_dns_st', end: 'rt_dns_end', name: 'dns', optional: true },
            { start: 'rt_con_st', end: 'rt_con_end', name: 'connect', optional: true },
            { start: 'rt_res_st', end: 'rt_res_end', name: 'response', optional: true }
        ],
        durations: []
    }
};

function normaliseCategory (map, data, startKey) {
    try {
        return {
            timestamps: normaliseTimestamps(map, data),
            events: normaliseEvents(map, data),
            durations: normaliseDurations(map, data, startKey)
        };
    } catch (e) {
    }
}

function normaliseTimestamps (map, data) {
    return map.timestamps.reduce(function (result, timestamp) {
        var value, assert;

        if (data[timestamp.key]) {
            value = parseInt(data[timestamp.key]);
        }

        assert = timestamp.optional ? check.assert.maybe : check.assert;
        assert.positive(value);

        if (value) {
            result[timestamp.name] = value;
        }

        return result;
    }, {});
}

function normaliseEvents (map, data) {
    return map.events.reduce(function (result, event) {
        var start, end, assert;

        if (data[event.start] && data[event.end]) {
            start = parseInt(data[event.start]);
            end = parseInt(data[event.end]);
        }

        assert = event.optional ? check.assert.maybe : check.assert;
        assert.number(start);
        check.assert.not.negative(start);
        assert.number(end);
        check.assert.not.negative(end);

        if (check.number(start) && check.number(end)) {
            result[event.name] = {
                start: start,
                end: end
            };
        }

        return result;
    }, {});
}

function normaliseDurations (map, data, startKey) {
    var start = parseInt(data[startKey]);

    return map.durations.reduce(function (result, duration) {
        var value, assert;

        if (data[duration.end]) {
            value = parseInt(data[duration.end]) - start;
        }

        assert = duration.optional ? check.assert.maybe : check.assert;
        assert.number(value);
        check.assert.not.negative(value);

        if (value) {
            result[duration.name] = value;
        }

        return result;
    }, {});
}

function normaliseRestimingData (data) {
    /*jshint camelcase:false */
    if (check.array(data.restiming)) {
        return data.restiming.map(function (datum) {
            var result = normaliseCategory(normalisationMaps.restiming, datum, 'rt_st');

            if (result) {
                result.name = datum.rt_name;
                result.type = datum.rt_in_type;
            }

            return result;
        });
    }
}

function pass (log, response, status, bytes) {
    log.info('sent ' + bytes + ' bytes');

    response.statusCode = status;
    response.end();
}

