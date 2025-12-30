# Discourse Amazon SNS Push Notifications

A Discourse plugin that enables push notifications via Amazon SNS for native mobile apps.

## Features

- ✅ **Lifecycle-Aware**: Automatically registers/unregisters devices based on user authentication state
- ✅ **Session-Based Auth**: No API keys needed in mobile apps
- ✅ **Multi-Device Support**: Users can receive notifications on multiple devices
- ✅ **Platform Agnostic**: Works with iOS (APNS) and Android (FCM)
- ✅ **Automatic Cleanup**: Server-side logout hook ensures devices are unregistered
- ✅ **Re-enablement**: Subscriptions are disabled (not deleted) on logout for easy re-enabling

## Installation

1. Add the plugin to your Discourse installation:
   ```bash
   cd /var/discourse/containers/app.yml
   ```

2. Add under the `hooks.after_code` section:
   ```yaml
   - git clone https://github.com/discourse/discourse-amazon-sns plugins/discourse-amazon-sns
   ```

3. Rebuild your container:
   ```bash
   cd /var/www/discourse
   ./launcher rebuild app
   ```

## Configuration

### 1. AWS SNS Setup

Create SNS Platform Applications in AWS Console:

**For iOS (APNS):**
1. Go to AWS SNS Console → Mobile Push → Platform applications
2. Create new application
3. Choose "Apple iOS (APNS)"
4. Upload your `.p8` key file or certificate
5. Copy the ARN

**For Android (FCM):**
1. Go to AWS SNS Console → Mobile Push → Platform applications
2. Create new application
3. Choose "Google Firebase Cloud Messaging (FCM)"
4. Enter your Server Key (from Firebase Console)
5. Copy the ARN

### 2. Discourse Settings

Configure in Admin → Settings → Plugins → discourse-amazon-sns:

| Setting | Description |
|---------|-------------|
| `enable_amazon_sns_pns` | Enable push notifications via SNS |
| `amazon_sns_access_key_id` | AWS access key ID |
| `amazon_sns_secret_access_key` | AWS secret access key |
| `amazon_sns_region` | AWS region (e.g., `us-west-2`) |
| `amazon_sns_apns_application_arn` | ARN of APNS application |
| `amazon_sns_gcm_application_arn` | ARN of FCM application |

## Native App Integration

See [NATIVE_INTEGRATION.md](NATIVE_INTEGRATION.md) for detailed integration guide.

### Quick Example

**In your native WebView (after Discourse loads):**

```javascript
window.SNS.configure({
  token: "device-token-from-apns-or-fcm",
  platform: "ios", // or "android"
  applicationName: "My App",
  onRegistered: (result) => {
    console.log("Device registered:", result.endpoint_arn);
  },
  onError: (error) => {
    console.error("Registration failed:", error.message);
  }
});
```

**That's it!** The plugin handles:
- Waiting for user authentication
- Registering when ready
- Unregistering on logout
- Re-enabling on next login

## How It Works

### Registration Flow

```
1. Native app gets device token from APNS/FCM
2. Native app calls window.SNS.configure(...)
3. Plugin stores token and waits for authentication
4. User logs into Discourse
5. Plugin automatically registers device with SNS
6. AWS SNS creates endpoint ARN
7. Subscription is stored in database
8. Native app receives onRegistered() callback
```

### Notification Flow

```
1. Discourse triggers push notification (mention, PM, etc.)
2. Plugin job queries user's active subscriptions
3. For each device, sends notification via AWS SNS
4. AWS SNS routes to APNS/FCM
5. Device receives push notification
6. User taps notification → app opens to content
```

### Logout Flow

```
1. User clicks logout in Discourse
2. JavaScript bridge calls unregister API
3. Subscription status set to "disabled"
4. Server-side logout hook also disables (backup)
5. Device stops receiving notifications
6. On next login, subscription is re-enabled
```

## Architecture

The plugin consists of three layers:

### 1. JavaScript Bridge (`sns-lifecycle-bridge.js`)
- Listens to Discourse lifecycle events
- Manages device token and configuration
- Coordinates registration/unregistration timing
- Provides callbacks to native app

### 2. Rails Controller (`amazon_sns_controller.rb`)
- Handles registration API endpoint (`POST /amazon-sns/subscribe`)
- Handles unregistration API endpoint (`POST /amazon-sns/disable`)
- Session-based authentication
- Manages subscription records

### 3. Background Jobs (`amazon_sns_notification.rb`)
- Processes push notification events
- Formats notifications for iOS/Android
- Sends via AWS SNS API
- Handles endpoint errors and cleanup

## Database Schema

### `amazon_sns_subscriptions` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | integer | Primary key |
| `user_id` | integer | User who owns this subscription |
| `device_token` | string | Device token from APNS/FCM |
| `platform` | string | "ios" or "android" |
| `application_name` | string | App name |
| `endpoint_arn` | string | AWS SNS endpoint ARN |
| `status` | integer | 0=disabled, 1=enabled |
| `status_changed_at` | datetime | When status last changed |
| `created_at` | datetime | When created |
| `updated_at` | datetime | When updated |

## API Endpoints

### `POST /amazon-sns/subscribe`

Register a device for push notifications.

**Authentication:** Requires user session (logged in)

**Request Body:**
```json
{
  "token": "device-token-string",
  "platform": "ios",
  "application_name": "My App",
  "device_name": "John's iPhone",
  "device_model": "iPhone 14 Pro",
  "app_version": "1.0.0"
}
```

**Response:**
```json
{
  "id": 123,
  "user_id": 456,
  "device_token": "...",
  "platform": "ios",
  "status": 1,
  "endpoint_arn": "arn:aws:sns:...",
  "created_at": "2025-01-01T00:00:00.000Z",
  "updated_at": "2025-01-01T00:00:00.000Z"
}
```

### `POST /amazon-sns/disable`

Unregister a device from push notifications.

**Authentication:** Requires user session (logged in)

**Request Body:**
```json
{
  "token": "device-token-string"
}
```

**Response:**
```json
{
  "id": 123,
  "status": 0,
  "status_changed_at": "2025-01-01T00:00:00.000Z"
}
```

## Testing

### Test Registration

```bash
# Get a valid session cookie first by logging into Discourse
# Then test the API:

curl -X POST https://your-discourse.com/amazon-sns/subscribe \
  -H "Content-Type: application/json" \
  -H "Cookie: _t=your-session-cookie" \
  -d '{
    "token": "test-device-token",
    "platform": "ios",
    "application_name": "Test App"
  }'
```

### Test Push Notification

Use AWS SNS Console:
1. Navigate to Applications → Your App → Endpoints
2. Find your device endpoint
3. Click "Publish message"
4. Enter test message and send

## Troubleshooting

### Notifications Not Arriving

**Check:**
1. AWS SNS credentials are correct in settings
2. Platform Application ARN is correct
3. Device is registered (check database: `AmazonSnsSubscription.where(user_id: user.id)`)
4. Subscription status is "enabled" (status = 1)
5. AWS SNS endpoint is enabled (check AWS Console)

**Logs:**
```bash
# Discourse logs
tail -f /var/discourse/shared/standalone/log/rails/production.log | grep SNS

# Filter for registration events
tail -f /var/discourse/shared/standalone/log/rails/production.log | grep "SNS subscription"
```

### Registration Failing

**Common issues:**
1. User not logged in (check session)
2. Invalid device token format
3. AWS credentials incorrect
4. AWS SNS region mismatch
5. Platform Application ARN not configured

### Logout Not Unregistering

The plugin has two mechanisms:
1. JavaScript-based unregistration (immediate)
2. Server-side logout hook (backup)

If JavaScript fails, the server-side hook will still disable subscriptions.

## Development

### Running Tests

```bash
bundle exec rspec plugins/discourse-amazon-sns/spec
```

### Modifying the JavaScript Bridge

The bridge is located at:
```
assets/javascripts/initializers/sns-lifecycle-bridge.js
```

Changes will be picked up after reloading Discourse (development mode) or rebuilding (production).

## License

MIT License - see [LICENSE](LICENSE)

## Credits

- Original plugin by Penar Musaraj (Discourse team)
- Lifecycle-aware bridge enhancements for native app integration

## Support

- GitHub Issues: https://github.com/discourse/discourse-amazon-sns/issues
- Discourse Meta: https://meta.discourse.org

