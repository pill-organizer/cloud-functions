# Smart Pill Organizer - Cloud Functions

Firebase Cloud Functions for the Smart Pill Organizer IoT system.

## Functions

### `sendPillReminderNotification`
Sends push notifications when new entries are created in `/notifications`.
- Validates notification data
- Checks device configuration
- Sends FCM notifications to subscribed devices

### `checkEnvironmentalThresholds`
Monitors environmental conditions and creates alerts.
- Triggered on new hourly readings
- Compares temperature/humidity against configured thresholds
- Creates notification entries for violations

### `aggregateDailyEnvironmentalData`
Aggregates hourly environmental data into daily summaries.
- Runs daily at 00:00 Asia/Tashkent time
- Calculates min, max, and average values
- Automatically cleans data older than 20 days

## Setup

```bash
npm install
npm run build
firebase deploy --only functions
```

## Requirements

- Node.js 24
- Firebase Blaze plan (for Cloud Scheduler)
- Firebase Realtime Database
- Firebase Cloud Messaging

## Database Structure

```
/device/config           # Device configuration and thresholds
/notifications           # Notification queue
/environmental/hourly    # Hourly sensor readings
/environmental/daily     # Aggregated daily summaries
```
