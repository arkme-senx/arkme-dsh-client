{
  "targets": [
    {
      "target_name": "arkme_notification_permission",
      "defines": [
        "NAPI_VERSION=4"
      ],
      "sources": [
        "src/notification_permission.mm"
      ],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CPLUSPLUSFLAGS": [
          "-std=c++20",
          "-stdlib=libc++"
        ],
        "OTHER_LDFLAGS": [
          "-framework Foundation",
          "-framework UserNotifications"
        ]
      }
    }
  ]
}
