#!/usr/bin/env node

/*jshint node:true */

// TODO: We should split this into a login-with-persona-and-create-couch-user
// and a create-database-per-couch-user module

// TODO: I think we probably need some way to specify an application prefix
// to use, if multiple applications use the same auth server their data
// will be messed up

"use strict";

var ASSERT_URL = 'https://verifier.login.persona.org/verify';
var DB_PREFIX = 'couch_persona_';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var url = require('url');

var _ = require('underscore');
var async = require('async');
var commander = require('commander');
var express = require('express');
var request = require('request');
var uuid = require('node-uuid');

var logger = require('./couch-persona-log.js');

function verifyAssert(assert, audience, callback) {
  logger.info('Verifying assertion');
  request({
    method: 'POST',
    json: true,
    uri: ASSERT_URL,
    form: {
      assertion: assert,
      audience: audience
    }
  }, callback);
}

function ensureUser(err, body, callback) {
  logger.info('Ensuring', body.email, 'user exists');
  var email = body.email;
  var userDoc = createUserDoc(email);
  var userDocUri = url.format(db) + '_users/' + userDoc._id;
  request({
    method: 'GET',
    uri: userDocUri
  }, function(err, res, body) {
    if (res.statusCode === 200) {
      // Copy over any existing attributes (including _rev so we can update it)
      userDoc = _.extend(body, userDoc);
    } else {
      userDoc.password = uuid.v1();
      userDoc.thepassword = userDoc.password;
      logger.info('User', body.email, 'doesnt exist, creating ...');
    }
    request({
      method: 'PUT',
      json: userDoc,
      uri: userDocUri
    }, function(err, res, body) {
      callback(null, userDoc);
    });
  });
}

function ensureDatabase(userDoc, callback) {
  logger.info('Ensuring', userDoc.db, 'exists');
  request({
    method: 'PUT',
    json: true,
    uri: url.format(db) + userDoc.db
  }, function(err, res, body) {
    if (!err && (res.statusCode === 201 || res.statusCode === 412)) {
      callback(null, userDoc);
    } else {
      callback({status: 400, json: {error: 'error_creating_database'}});
    }
  });
}

function ensureUserSecurity(userDoc, callback) {
  logger.info('Ensuring', userDoc.name, 'only can write to', userDoc.db);
  var securityDoc = {
    admins: {names:[], roles: []},
    readers: {names: [userDoc.name], roles: []}
  };
  request({
    method: 'PUT',
    json: securityDoc,
    uri: url.format(db) + userDoc.db + '/_security'
  }, function(err, res, body) {
    if (!err) {
      callback(null, userDoc);
    } else {
      callback({status: 400, json: {error: 'error_securing_database'}});
    }
  });

}

function createSessionToken(userDoc, callback) {
  logger.info('Creating session');
  request({
    method: 'POST',
    uri: url.format(db) + '_session',
    form: {
      name: userDoc.name,
      password: userDoc.thepassword
    }
  }, function(err, res, body) {
    if (res.statusCode === 200) {
      var cookies = parseCookie(res.headers['set-cookie'][0]);
      userDoc.authToken = 'AuthSession=' + cookies.AuthSession;
      callback(null, userDoc);
    } else {
      callback({error: 'screwed'});
    }
  });
}

function parseCookie(str) {
  var cookies = {};
  str.split(';').forEach(function(cookie) {
    var parts = cookie.split('=');
    cookies[parts[0].trim()] = (parts[1] || '').trim();
  });
  return cookies;
}

function sendJSON(client, status, content, hdrs) {
  var headers = _.extend({'Content-Type': 'application/json'}, hdrs);
  client.writeHead(status, headers);
  client.write(JSON.stringify(content));
  client.end();
}

function createUserDoc(email) {
  // Email addresses arent valid database names, so just hash them
  var dbName = DB_PREFIX + crypto.createHash('md5').update(email).digest("hex");
  return {
    _id: 'org.couchdb.user:' + encodeURIComponent(email),
    type: 'user',
    name: email,
    roles: ['browserid'],
    browserid: true,
    db: dbName
  };
}

function allowCrossDomain(req, res, next) {
  res.header('Access-Control-Allow-Origin', req.headers.origin);
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
};

commander
  .version('0.0.1')
  .option('--host [value]', 'location of me')
  .option('--db [value]', 'location of couch http://127.0.0.1:5984')
  .option('--username [value]', 'CouchDB admin username')
  .option('--password [value]', 'CouchDB admin password')
  .option('--port <n>', 'Port number to run couch-persona on', parseInt)
  .parse(process.argv);

if (!commander.host || !commander.db) {
  console.log('The host argument is required');
  commander.help();
  process.exit(1);
}

var db = url.parse(commander.db);
var host = url.parse(commander.host);

var app = express();

app.configure(function() {

  app.use(allowCrossDomain);
  app.use(express.cookieParser());

  app.use('/db/', function(req, res) {
    var erl = url.format(db) + req.url.substring(1);
    req.pipe(request(erl)).pipe(res);
  });

  app.use(express.bodyParser());
});

app.post('/persona/sign-in', function(req, res) {
  async.waterfall([
    verifyAssert.bind(this, req.body.assertion, req.headers.origin),
    ensureUser,
    ensureDatabase,
    ensureUserSecurity,
    createSessionToken
  ], function (err, userDoc) {
    if (err) {
      sendJSON(res, err.status, err.json);
    } else {
      sendJSON(res, 200, {
        ok: true,
        db: url.format(host) + 'db/' + userDoc.db,
        email: userDoc.email,
        name: userDoc.name
      }, {'Set-Cookie': userDoc.authToken});
    }
  });
});

app.post('/persona/sign-out', function(req, res) {
  // TODO: We should probably try and kill the session or something
  // but right now we dont know anything about it (since the authToken
  // is stored locally and not sent as a cookie)
  sendJSON(res, 400, {
    ok: true
  });
});

// TODO: We should verify that we have a running CouchDB instance, and probably
// also test for CORS being enabled and warn if not

if (!commander.username || !commander.password) {
  // TODO: Ensure we are in admin party or fail nicely
  // remember to request = request.defaults({json: true});
  console.log('You are not in admin party');
  process.exit(1);
} else {
  request = request.defaults({
    json: true,
    auth: {
      username: commander.username,
      password: commander.password
    }
  });
}

app.listen(commander.port || 3000);
