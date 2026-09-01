"use strict";

const binding = require("./build/Release/arkme_notification_permission.node");

module.exports = Object.freeze({
  queryNotificationAuthorizationStatus: async () => (
    await binding.queryNotificationSettings()
  )
});
