///
/// CURRENT USER
///

Meteor.userId = function () {
  // This function only works if called inside a method. In theory, it
  // could also be called from publish statements, since they also
  // have a userId associated with them. However, given that publish
  // functions aren't reactive, using any of the infomation from
  // Meteor.user() in a publish function will always use the value
  // from when the function first runs. This is likely not what the
  // user expects. The way to make this work in a publish is to do
  // Meteor.find(this.userId()).observe and recompute when the user
  // record changes.
  var currentInvocation = DDP._CurrentInvocation.get();
  if (!currentInvocation)
    throw new Error("Meteor.userId can only be invoked in method calls. Use this.userId in publish functions.");
  return currentInvocation.userId;
};

Meteor.user = function () {
  var userId = Meteor.userId();
  if (!userId)
    return null;
  return Meteor.users.findOne(userId);
};

///
/// LOGIN HANDLERS
///

// The main entry point for auth packages to hook in to login.
//
// @param handler {Function} A function that receives an options object
// (as passed as an argument to the `login` method) and returns one of:
// - `undefined`, meaning don't handle;
// - {id: userId, token: *, tokenExpires: *}, if the user logged in
//   successfully. tokenExpires is optional and intends to provide a hint to the
//   client as to when the token will expire. If not provided, the client will
//   call Accounts._tokenExpiration, passing it the date that it received the
//   token.
// - throw an error, if the user failed to log in.
//
Accounts.registerLoginHandler = function(handler) {
  loginHandlers.push(handler);
};

// list of all registered handlers.
loginHandlers = [];


// Try all of the registered login handlers until one of them doesn'
// return `undefined`, meaning it handled this call to `login`. Return
// that return value, which ought to be a {id/token} pair.
var tryAllLoginHandlers = function (options) {
  for (var i = 0; i < loginHandlers.length; ++i) {
    var handler = loginHandlers[i];
    var result = handler(options);
    if (result !== undefined)
      return result;
  }

  throw new Meteor.Error(400, "Unrecognized options for login request");
};


// Actual methods for login and logout. This is the entry point for
// clients to actually log in.
Meteor.methods({
  // @returns {Object|null}
  //   If successful, returns {token: reconnectToken, id: userId}
  //   If unsuccessful (for example, if the user closed the oauth login popup),
  //     returns null
  login: function(options) {
    // Login handlers should really also check whatever field they look at in
    // options, but we don't enforce it.
    check(options, Object);
    var result = tryAllLoginHandlers(options);
    if (result !== null) {
      this.setUserId(result.id);
      this._setLoginToken(result.token);
    }
    return result;
  },

  logout: function() {
    var token = this._getLoginToken();
    this._setLoginToken(null);
    if (token && this.userId)
      removeLoginToken(this.userId, token);
    this.setUserId(null);
  },

  // Nuke everything: delete all the current user's tokens and close all open
  // connections logged in as this user. Returns a fresh new login token that
  // this client can use.
  _logoutAllOthers: function () {
    var self = this;
    var user = Meteor.users.findOne(self.userId, {
      fields: {
        "services.resume.loginTokens": true
      }
    });
    if (user) {
      var tokens = user.services.resume.loginTokens;
      var newToken = Accounts._generateStampedLoginToken();
      Meteor.users.update(self.userId, {
        $set: {
          "services.resume.loginTokens": [newToken]
        }
      });
      // We do not set the login token on this connection, but instead the
      // observe closes the connection and the client will reconnect with the
      // new token.
      return {
        token: newToken.token,
        tokenExpires: Accounts._tokenExpiration(newToken.when)
      };
    } else {
      throw new Error("You are not logged in.");
    }
  }
});

///
/// RECONNECT TOKENS
///
/// support reconnecting using a meteor login token

// how often (in seconds) we check for expired tokens
var DEFAULT_EXPIRE_TOKENS_INTERVAL_SECS = 600; // 10 minutes

// Login handler for resume tokens.
Accounts.registerLoginHandler(function(options) {
  if (!options.resume)
    return undefined;

  check(options.resume, String);
  var user = Meteor.users.findOne({
    "services.resume.loginTokens.token": ""+options.resume
  });

  if (!user) {
    throw new Meteor.Error(403, "You've been logged out by the server. " +
    "Please login again.");
  }

  var token = _.find(user.services.resume.loginTokens, function (token) {
    return token.token === options.resume;
  });

  var tokenExpires = Accounts._tokenExpiration(token.when);
  if (new Date() >= tokenExpires)
    throw new Meteor.Error(403, "Your session has expired. Please login again.");

  return {
    token: options.resume,
    tokenExpires: tokenExpires,
    id: user._id
  };
});

// Semi-public. Used by other login methods to generate tokens.
//
Accounts._generateStampedLoginToken = function () {
  return {token: Random.id(), when: (new Date)};
};

// Deletes the given loginToken from the database. This will cause all
// connections associated with the token to be closed.
var removeLoginToken = function (userId, loginToken) {
  Meteor.users.update(userId, {
    $pull: {
      "services.resume.loginTokens": { "token": loginToken }
    }
  });
};

///
/// TOKEN EXPIRATION
///

var expireTokenInterval;

// Deletes expired tokens from the database and closes all open connections
// associated with these tokens. Exported for tests.
var expireTokens = Accounts._expireTokens = function (oldestValidDate) {
  var tokenLifetimeSecs = Accounts._options._tokenLifetimeSecs ||
        DEFAULT_TOKEN_LIFETIME_SECS;
  oldestValidDate = oldestValidDate ||
    (new Date(new Date() - tokenLifetimeSecs * 1000));

  Meteor.users.update({
    "services.resume.loginTokens.when": { $lt: oldestValidDate }
  }, {
    $pull: {
      "services.resume.loginTokens": {
        when: { $lt: oldestValidDate }
      }
    }
  }, { multi: true });
  // The observe on Meteor.users will take care of closing connections for
  // expired tokens.
};

Meteor.users._ensureIndex("services.resume.loginTokens.when", { sparse: true });

initExpireTokenInterval = function () {
  if (expireTokenInterval)
    Meteor.clearInterval(expireTokenInterval);
  var expirePeriodSecs = Accounts._options._tokenExpirationIntervalSecs ||
        DEFAULT_EXPIRE_TOKENS_INTERVAL_SECS;
  expireTokenInterval = Meteor.setInterval(expireTokens, expirePeriodSecs * 1000);
};
initExpireTokenInterval();

///
/// CREATE USER HOOKS
///

var onCreateUserHook = null;
Accounts.onCreateUser = function (func) {
  if (onCreateUserHook)
    throw new Error("Can only call onCreateUser once");
  else
    onCreateUserHook = func;
};

// XXX see comment on Accounts.createUser in passwords_server about adding a
// second "server options" argument.
var defaultCreateUserHook = function (options, user) {
  if (options.profile)
    user.profile = options.profile;
  return user;
};

// Called by accounts-password
Accounts.insertUserDoc = function (options, user) {
  // - clone user document, to protect from modification
  // - add createdAt timestamp
  // - prepare an _id, so that you can modify other collections (eg
  // create a first task for every new user)
  //
  // XXX If the onCreateUser or validateNewUser hooks fail, we might
  // end up having modified some other collection
  // inappropriately. The solution is probably to have onCreateUser
  // accept two callbacks - one that gets called before inserting
  // the user document (in which you can modify its contents), and
  // one that gets called after (in which you should change other
  // collections)
  user = _.extend({createdAt: new Date(), _id: Random.id()}, user);

  var result = {};
  if (options.generateLoginToken) {
    var stampedToken = Accounts._generateStampedLoginToken();
    result.token = stampedToken.token;
    result.tokenExpires = Accounts._tokenExpiration(stampedToken.when);
    Meteor._ensure(user, 'services', 'resume');
    if (_.has(user.services.resume, 'loginTokens'))
      user.services.resume.loginTokens.push(stampedToken);
    else
      user.services.resume.loginTokens = [stampedToken];
  }

  var fullUser;
  if (onCreateUserHook) {
    fullUser = onCreateUserHook(options, user);

    // This is *not* part of the API. We need this because we can't isolate
    // the global server environment between tests, meaning we can't test
    // both having a create user hook set and not having one set.
    if (fullUser === 'TEST DEFAULT HOOK')
      fullUser = defaultCreateUserHook(options, user);
  } else {
    fullUser = defaultCreateUserHook(options, user);
  }

  _.each(validateNewUserHooks, function (hook) {
    if (!hook(fullUser))
      throw new Meteor.Error(403, "User validation failed");
  });

  try {
    result.id = Meteor.users.insert(fullUser);
  } catch (e) {
    // XXX string parsing sucks, maybe
    // https://jira.mongodb.org/browse/SERVER-3069 will get fixed one day
    if (e.name !== 'MongoError') throw e;
    var match = e.err.match(/^E11000 duplicate key error index: ([^ ]+)/);
    if (!match) throw e;
    if (match[1].indexOf('$emails.address') !== -1)
      throw new Meteor.Error(403, "Email already exists.");
    if (match[1].indexOf('username') !== -1)
      throw new Meteor.Error(403, "Username already exists.");
    // XXX better error reporting for services.facebook.id duplicate, etc
    throw e;
  }

  return result;
};

var validateNewUserHooks = [];
Accounts.validateNewUser = function (func) {
  validateNewUserHooks.push(func);
};


///
/// MANAGING USER OBJECTS
///

// Updates or creates a user after we authenticate with a 3rd party.
//
// @param serviceName {String} Service name (eg, twitter).
// @param serviceData {Object} Data to store in the user's record
//        under services[serviceName]. Must include an "id" field
//        which is a unique identifier for the user in the service.
// @param options {Object, optional} Other options to pass to insertUserDoc
//        (eg, profile)
// @returns {Object} Object with token and id keys, like the result
//        of the "login" method.
//
Accounts.updateOrCreateUserFromExternalService = function(
  serviceName, serviceData, options) {
  options = _.clone(options || {});

  if (serviceName === "password" || serviceName === "resume")
    throw new Error(
      "Can't use updateOrCreateUserFromExternalService with internal service "
        + serviceName);
  if (!_.has(serviceData, 'id'))
    throw new Error(
      "Service data for service " + serviceName + " must include id");

  // Look for a user with the appropriate service user id.
  var selector = {};
  var serviceIdKey = "services." + serviceName + ".id";

  // XXX Temporary special case for Twitter. (Issue #629)
  //   The serviceData.id will be a string representation of an integer.
  //   We want it to match either a stored string or int representation.
  //   This is to cater to earlier versions of Meteor storing twitter
  //   user IDs in number form, and recent versions storing them as strings.
  //   This can be removed once migration technology is in place, and twitter
  //   users stored with integer IDs have been migrated to string IDs.
  if (serviceName === "twitter" && !isNaN(serviceData.id)) {
    selector["$or"] = [{},{}];
    selector["$or"][0][serviceIdKey] = serviceData.id;
    selector["$or"][1][serviceIdKey] = parseInt(serviceData.id, 10);
  } else {
    selector[serviceIdKey] = serviceData.id;
  }

  var user = Meteor.users.findOne(selector);

  if (user) {
    // We *don't* process options (eg, profile) for update, but we do replace
    // the serviceData (eg, so that we keep an unexpired access token and
    // don't cache old email addresses in serviceData.email).
    // XXX provide an onUpdateUser hook which would let apps update
    //     the profile too
    var stampedToken = Accounts._generateStampedLoginToken();
    var setAttrs = {};
    _.each(serviceData, function(value, key) {
      setAttrs["services." + serviceName + "." + key] = value;
    });

    // XXX Maybe we should re-use the selector above and notice if the update
    //     touches nothing?
    Meteor.users.update(
      user._id,
      {$set: setAttrs,
       $push: {'services.resume.loginTokens': stampedToken}});
    return {
      token: stampedToken.token,
      id: user._id,
      tokenExpires: Accounts._tokenExpiration(stampedToken.when)
    };
  } else {
    // Create a new user with the service data. Pass other options through to
    // insertUserDoc.
    user = {services: {}};
    user.services[serviceName] = serviceData;
    options.generateLoginToken = true;
    return Accounts.insertUserDoc(options, user);
  }
};


///
/// PUBLISHING DATA
///

// Publish the current user's record to the client.
Meteor.publish(null, function() {
  if (this.userId) {
    return Meteor.users.find(
      {_id: this.userId},
      {fields: {profile: 1, username: 1, emails: 1}});
  } else {
    return null;
  }
}, /*suppress autopublish warning*/{is_auto: true});

// If autopublish is on, publish these user fields. Login service
// packages (eg accounts-google) add to these by calling
// Accounts.addAutopublishFields Notably, this isn't implemented with
// multiple publishes since DDP only merges only across top-level
// fields, not subfields (such as 'services.facebook.accessToken')
var autopublishFields = {
  loggedInUser: ['profile', 'username', 'emails'],
  otherUsers: ['profile', 'username']
};

// Add to the list of fields or subfields to be automatically
// published if autopublish is on. Must be called from top-level
// code (ie, before Meteor.startup hooks run).
//
// @param opts {Object} with:
//   - forLoggedInUser {Array} Array of fields published to the logged-in user
//   - forOtherUsers {Array} Array of fields published to users that aren't logged in
Accounts.addAutopublishFields = function(opts) {
  autopublishFields.loggedInUser.push.apply(
    autopublishFields.loggedInUser, opts.forLoggedInUser);
  autopublishFields.otherUsers.push.apply(
    autopublishFields.otherUsers, opts.forOtherUsers);
};

if (Package.autopublish) {
  // Use Meteor.startup to give other packages a chance to call
  // addAutopublishFields.
  Meteor.startup(function () {
    // ['profile', 'username'] -> {profile: 1, username: 1}
    var toFieldSelector = function(fields) {
      return _.object(_.map(fields, function(field) {
        return [field, 1];
      }));
    };

    Meteor.server.publish(null, function () {
      if (this.userId) {
        return Meteor.users.find(
          {_id: this.userId},
          {fields: toFieldSelector(autopublishFields.loggedInUser)});
      } else {
        return null;
      }
    }, /*suppress autopublish warning*/{is_auto: true});

    // XXX this publish is neither dedup-able nor is it optimized by our special
    // treatment of queries on a specific _id. Therefore this will have O(n^2)
    // run-time performance every time a user document is changed (eg someone
    // logging in). If this is a problem, we can instead write a manual publish
    // function which filters out fields based on 'this.userId'.
    Meteor.server.publish(null, function () {
      var selector;
      if (this.userId)
        selector = {_id: {$ne: this.userId}};
      else
        selector = {};

      return Meteor.users.find(
        selector,
        {fields: toFieldSelector(autopublishFields.otherUsers)});
    }, /*suppress autopublish warning*/{is_auto: true});
  });
}

// Publish all login service configuration fields other than secret.
Meteor.publish("meteor.loginServiceConfiguration", function () {
  return ServiceConfiguration.configurations.find({}, {fields: {secret: 0}});
}, {is_auto: true}); // not techincally autopublish, but stops the warning.

// Allow a one-time configuration for a login service. Modifications
// to this collection are also allowed in insecure mode.
Meteor.methods({
  "configureLoginService": function (options) {
    check(options, Match.ObjectIncluding({service: String}));
    // Don't let random users configure a service we haven't added yet (so
    // that when we do later add it, it's set up with their configuration
    // instead of ours).
    // XXX if service configuration is oauth-specific then this code should
    //     be in accounts-oauth; if it's not then the registry should be
    //     in this package
    if (!(Accounts.oauth
          && _.contains(Accounts.oauth.serviceNames(), options.service))) {
      throw new Meteor.Error(403, "Service unknown");
    }
    if (ServiceConfiguration.configurations.findOne({service: options.service}))
      throw new Meteor.Error(403, "Service " + options.service + " already configured");
    ServiceConfiguration.configurations.insert(options);
  }
});


///
/// RESTRICTING WRITES TO USER OBJECTS
///

Meteor.users.allow({
  // clients can modify the profile field of their own document, and
  // nothing else.
  update: function (userId, user, fields, modifier) {
    // make sure it is our record
    if (user._id !== userId)
      return false;

    // user can only modify the 'profile' field. sets to multiple
    // sub-keys (eg profile.foo and profile.bar) are merged into entry
    // in the fields list.
    if (fields.length !== 1 || fields[0] !== 'profile')
      return false;

    return true;
  },
  fetch: ['_id'] // we only look at _id.
});

/// DEFAULT INDEXES ON USERS
Meteor.users._ensureIndex('username', {unique: 1, sparse: 1});
Meteor.users._ensureIndex('emails.address', {unique: 1, sparse: 1});
Meteor.users._ensureIndex('services.resume.loginTokens.token',
                          {unique: 1, sparse: 1});

///
/// LOGGING OUT DELETED USERS
///

var DEFAULT_CONNECTION_CLOSE_DELAY_SECS = 10;

// By default, connections are closed with a 10 second delay, to give other
// clients a chance to find a new token in localStorage before
// reconnecting. Delay can be configured with Accounts.config.
var closeTokensForUser = function (userTokens) {
  var delaySecs = DEFAULT_CONNECTION_CLOSE_DELAY_SECS;
  if (_.has(Accounts._options, "_connectionCloseDelaySecs"))
    delaySecs = Accounts._options._connectionCloseDelaySecs;
  Meteor.setTimeout(function () {
    Meteor.server._closeAllForTokens(_.map(userTokens, function (token) {
      return token.token;
    }));
  }, delaySecs * 1000);
};

Meteor.users.find().observe({
  changed: function (newUser, oldUser) {
    var removedTokens = [];
    if (newUser.services && newUser.services.resume &&
        oldUser.services && oldUser.services.resume) {
      removedTokens = _.difference(oldUser.services.resume.loginTokens || [],
                                   newUser.services.resume.loginTokens || []);
    } else if (oldUser.services && oldUser.services.resume) {
      removedTokens = oldUser.services.resume.loginTokens || [];
    }
    closeTokensForUser(removedTokens);
  },
  removed: function (oldUser) {
    if (oldUser.services && oldUser.services.resume)
      closeTokensForUser(oldUser.services.resume.loginTokens || []);
  }
});
