#include <node_api.h>

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

namespace {

struct NotificationSettingsResult {
  NSInteger authorizationStatus;
  NSInteger alertSetting;
  NSInteger notificationCenterSetting;
  NSInteger soundSetting;
  NSInteger badgeSetting;
};

struct QueryContext {
  napi_deferred deferred;
  napi_threadsafe_function threadSafeFunction;
};

napi_value NoOp(napi_env env, napi_callback_info) {
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

void SetIntegerProperty(napi_env env,
                        napi_value target,
                        const char *name,
                        NSInteger value) {
  napi_value property;
  napi_create_int64(env, static_cast<int64_t>(value), &property);
  napi_set_named_property(env, target, name, property);
}

void DeliverSettings(napi_env env,
                     napi_value,
                     void *contextData,
                     void *resultData) {
  auto *context = static_cast<QueryContext *>(contextData);
  auto *result = static_cast<NotificationSettingsResult *>(resultData);
  if (env != nullptr && result != nullptr) {
    napi_value value;
    napi_create_object(env, &value);
    SetIntegerProperty(env, value, "authorizationStatus", result->authorizationStatus);
    SetIntegerProperty(env, value, "alertSetting", result->alertSetting);
    SetIntegerProperty(
        env, value, "notificationCenterSetting", result->notificationCenterSetting);
    SetIntegerProperty(env, value, "soundSetting", result->soundSetting);
    SetIntegerProperty(env, value, "badgeSetting", result->badgeSetting);
    napi_resolve_deferred(env, context->deferred, value);
  }
  delete result;
}

void FinalizeQuery(napi_env, void *finalizeData, void *) {
  delete static_cast<QueryContext *>(finalizeData);
}

napi_value QueryNotificationSettings(napi_env env, napi_callback_info) {
  napi_value promise;
  napi_deferred deferred;
  napi_create_promise(env, &deferred, &promise);

  napi_value asyncResourceName;
  napi_create_string_utf8(
      env,
      "arkmeNotificationSettings",
      NAPI_AUTO_LENGTH,
      &asyncResourceName);
  napi_value noOp;
  napi_create_function(env, "noop", NAPI_AUTO_LENGTH, NoOp, nullptr, &noOp);

  auto *context = new QueryContext{deferred, nullptr};
  napi_status createStatus = napi_create_threadsafe_function(
      env,
      noOp,
      nullptr,
      asyncResourceName,
      1,
      1,
      context,
      FinalizeQuery,
      context,
      DeliverSettings,
      &context->threadSafeFunction);
  if (createStatus != napi_ok) {
    delete context;
    napi_value message;
    napi_create_string_utf8(
        env,
        "Unable to initialize notification permission query",
        NAPI_AUTO_LENGTH,
        &message);
    napi_value error;
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, deferred, error);
    return promise;
  }

  [[UNUserNotificationCenter currentNotificationCenter]
      getNotificationSettingsWithCompletionHandler:^(
          UNNotificationSettings *settings) {
        auto *result = new NotificationSettingsResult{
            settings.authorizationStatus,
            settings.alertSetting,
            settings.notificationCenterSetting,
            settings.soundSetting,
            settings.badgeSetting};
        napi_status callStatus = napi_call_threadsafe_function(
            context->threadSafeFunction,
            result,
            napi_tsfn_nonblocking);
        if (callStatus != napi_ok) delete result;
        napi_release_threadsafe_function(
            context->threadSafeFunction,
            napi_tsfn_release);
      }];

  return promise;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value query;
  napi_create_function(
      env,
      "queryNotificationSettings",
      NAPI_AUTO_LENGTH,
      QueryNotificationSettings,
      nullptr,
      &query);
  napi_set_named_property(env, exports, "queryNotificationSettings", query);
  return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
