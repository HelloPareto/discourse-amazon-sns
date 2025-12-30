# Native App Integration Guide

This guide explains how to integrate native mobile apps with the discourse-amazon-sns plugin using the new lifecycle-aware bridge.

## Overview

The plugin now automatically manages device registration and unregistration by hooking into Discourse's authentication lifecycle events. Native apps simply provide their device token, and the plugin handles all timing and coordination.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Native App Layer                   │
│  - Get device token from APNS/FCM                   │
│  - Call window.SNS.configure() once                 │
│  - Receive callbacks on success/error               │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│              JavaScript Bridge Layer                │
│  - Listen to Discourse auth lifecycle events        │
│  - Auto-register when user authenticates            │
│  - Auto-unregister when user logs out               │
│  - Coordinate timing automatically                  │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│               Discourse Backend Layer               │
│  - Create/update SNS endpoints                      │
│  - Handle push notifications                        │
│  - Cleanup on logout (server-side)                  │
└─────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Get Device Token

First, register for push notifications in your native app and get the device token:

**iOS (Swift):**
```swift
func application(_ application: UIApplication, 
                 didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    let tokenString = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
    // Store token for later use
    self.deviceToken = tokenString
}
```

**Android (Kotlin):**
```kotlin
FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
    if (task.isSuccessful) {
        val token = task.result
        // Store token for later use
    }
}
```

### 2. Configure the Bridge

Once you have the device token AND the Discourse WebView is loaded, call `window.SNS.configure()`:

**iOS (Swift with WKWebView):**
```swift
let script = """
    if (window.SNS && window.SNS.configure) {
        window.SNS.configure({
            token: '\(deviceToken)',
            platform: 'ios',
            applicationName: 'My App',
            deviceName: '\(UIDevice.current.name)',
            deviceModel: '\(UIDevice.current.model)',
            appVersion: '\(appVersion)',
            onRegistered: function(result) {
                console.log('Device registered:', result);
                window.webkit.messageHandlers.pushRegistered?.postMessage(result);
            },
            onUnregistered: function() {
                console.log('Device unregistered');
                window.webkit.messageHandlers.pushUnregistered?.postMessage({});
            },
            onError: function(error) {
                console.error('Push notification error:', error);
                window.webkit.messageHandlers.pushError?.postMessage(error);
            }
        });
    }
"""

webView.evaluateJavaScript(script)
```

**Android (Kotlin with WebView):**
```kotlin
val script = """
    if (window.SNS && window.SNS.configure) {
        window.SNS.configure({
            token: '$deviceToken',
            platform: 'android',
            applicationName: 'My App',
            deviceName: '${Build.MODEL}',
            deviceModel: '${Build.DEVICE}',
            appVersion: '${BuildConfig.VERSION_NAME}',
            onRegistered: function(result) {
                console.log('Device registered:', result);
                Android.onPushRegistered(JSON.stringify(result));
            },
            onUnregistered: function() {
                console.log('Device unregistered');
                Android.onPushUnregistered();
            },
            onError: function(error) {
                console.error('Push notification error:', error);
                Android.onPushError(JSON.stringify(error));
            }
        });
    }
""".trimIndent()

webView.evaluateJavascript(script, null)
```

### 3. That's It!

The plugin will automatically:
- ✅ Register the device when the user authenticates
- ✅ Store the token until authentication completes
- ✅ Re-enable subscriptions if the device logs in again
- ✅ Unregister the device when the user logs out
- ✅ Update badge counts on notification events

## API Reference

### `window.SNS.configure(config)`

Main configuration method for native apps.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `token` | string | Yes | Device token from APNS/FCM |
| `platform` | string | Yes | Platform: `"ios"` or `"android"` |
| `applicationName` | string | No | App name (default: "Discourse Mobile") |
| `deviceName` | string | No | Device name (e.g., "John's iPhone") |
| `deviceModel` | string | No | Device model (e.g., "iPhone 14 Pro") |
| `appVersion` | string | No | App version (e.g., "1.0.0") |
| `onRegistered` | function | No | Called when device is successfully registered |
| `onUnregistered` | function | No | Called when device is unregistered |
| `onError` | function | No | Called when an error occurs |

**Callback Signatures:**

```javascript
onRegistered(result: {
  id: number,
  user_id: number,
  device_token: string,
  platform: string,
  status: number,
  endpoint_arn: string,
  created_at: string,
  updated_at: string
})

onUnregistered()

onError(error: {
  type: 'registration' | 'unregistration',
  message: string,
  statusCode?: number
})
```

### Additional Methods

These methods are available for advanced use cases or testing:

```javascript
// Manually trigger registration (usually not needed)
window.SNS.register()

// Manually trigger unregistration
window.SNS.unregister()

// Check if device is currently registered
const isRegistered = window.SNS.isRegistered()

// Get current configuration
const config = window.SNS.getConfig()
```

## Lifecycle Events

The plugin automatically hooks into these Discourse lifecycle events:

1. **User Authentication** - Triggers when user logs in
   - If device token is configured, registration happens automatically
   
2. **User Logout** - Triggers when user logs out
   - Device is automatically unregistered
   - Server-side cleanup also disables the subscription

3. **Page Navigation** - Updates badge counts
   - Badge count syncs automatically on page changes

4. **Before Unload** - Cleanup on page unload
   - Best-effort unregistration (with server-side backup)

## Migration from Old API

If you're migrating from the old `subscribeDeviceToken()` API:

**Old API (deprecated):**
```javascript
window.SNS.subscribeDeviceToken(token, platform, application_name);
```

**New API:**
```javascript
window.SNS.configure({
  token: token,
  platform: platform,
  applicationName: application_name,
  onRegistered: (result) => { /* handle success */ }
});
```

The old API still works for backwards compatibility but is deprecated.

## Benefits vs Manual Registration

### Before (Manual Registration in Native Code)

❌ ~300 lines of Swift code to detect authentication  
❌ Cookie observers to detect logout  
❌ JavaScript injection to extract username  
❌ Complex timing coordination  
❌ CSRF token management  
❌ Different logic for iOS and Android  

### After (Lifecycle-Aware Bridge)

✅ One simple `configure()` call  
✅ Automatic timing coordination  
✅ Reliable logout detection via Discourse events  
✅ Same API for iOS and Android  
✅ Session-based authentication (no API keys needed)  
✅ Server-side cleanup as backup  

## Troubleshooting

### Device Not Registering

**Check:**
1. User is authenticated in Discourse
2. Device token is valid (not empty)
3. Platform is "ios" or "android"
4. Browser console for JavaScript errors
5. Discourse logs for server-side errors

**Solution:**
```javascript
// Check registration status
console.log('Is registered:', window.SNS.isRegistered());
console.log('Current config:', window.SNS.getConfig());

// Manually trigger registration (if needed)
window.SNS.register();
```

### Device Not Unregistering on Logout

**Check:**
1. Logout event is firing
2. Browser console for JavaScript errors
3. Server logs for user_logged_out event

**Solution:**
The server-side logout hook provides automatic cleanup even if the JavaScript unregistration fails.

### Multiple Devices for Same User

This is supported! Each device gets its own subscription record. When a user logs in from multiple devices, all devices will receive push notifications.

## Server-Side Details

### Logout Hook

The plugin adds a `user_logged_out` event handler that automatically disables all active subscriptions for a user:

```ruby
on(:user_logged_out) do |user|
  user.amazon_sns_subscriptions
    .where(status: AmazonSnsSubscription.statuses[:enabled])
    .update_all(
      status: AmazonSnsSubscription.statuses[:disabled],
      status_changed_at: Time.zone.now
    )
end
```

### Session-Based Authentication

The controller uses `ensure_logged_in` which validates the user's session. This means:
- ✅ No API key required from native app
- ✅ Uses standard Discourse authentication
- ✅ CSRF protection handled by Discourse
- ✅ Works with any OAuth provider

### Subscription Re-enablement

When a user logs in again with the same device token:
- The existing subscription is found
- Status is changed from `disabled` to `enabled`
- No new SNS endpoint is created (saves AWS API calls)

## Best Practices

1. **Call configure() after WebView loads** - Wait for Discourse to fully load before calling `window.SNS.configure()`

2. **Handle all callbacks** - Implement `onError` to catch registration failures

3. **Store token securely** - Keep the device token in native code, not JavaScript

4. **Test logout flow** - Ensure devices stop receiving notifications after logout

5. **Monitor server logs** - Check Discourse logs for registration/unregistration events

## Example Integration

See the `discourse-mobile-app` repository for a complete example of integrating with a Capacitor-based mobile app.

Key files:
- `ios/App/App/AppDelegate.swift` - iOS integration
- `src/providers/amazon-sns-push.provider.ts` - Push notification provider
- `www/main.ts` - Bootstrap logic

## Support

For issues or questions:
1. Check Discourse logs for errors
2. Check browser console for JavaScript errors
3. Verify AWS SNS configuration
4. Check the plugin's GitHub repository

