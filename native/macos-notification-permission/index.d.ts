export interface MacNotificationSettings {
  authorizationStatus: number;
  alertSetting: number;
  notificationCenterSetting: number;
  soundSetting: number;
  badgeSetting: number;
}

export function queryNotificationAuthorizationStatus(): Promise<MacNotificationSettings>;
