import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

admin.initializeApp();

// ============================================================================
// Type Definitions
// ============================================================================

interface NotificationData {
  type: "pill_reminder" | "environment_alert";
  message: string;
  timestamp: number;
  delivered?: boolean;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
  deliveredAt?: number;
  lastAttemptAt?: number;
}

interface DeviceConfig {
  pinHash: string;
  rfidTokens: { [key: string]: string };
  tempMin: number;
  tempMax: number;
  humidityMin: number;
  humidityMax: number;
  buzzerEnabled: boolean;
  pushNotificationsEnabled: boolean;
  lastSync: number;
}

interface EnvironmentalReading {
  temperature: number;
  humidity: number;
  timestamp: number;
}

interface DailyEnvironmentalData {
  tempMin: number;
  tempMax: number;
  tempAvg: number;
  humidityMin: number;
  humidityMax: number;
  humidityAvg: number;
  date: string;
}

// ============================================================================
// Constants
// ============================================================================

const DB_PATHS = {
  DEVICE_CONFIG: "/device/config",
  NOTIFICATIONS: "/notifications",
  ENVIRONMENTAL_HOURLY: "/environmental/hourly",
  ENVIRONMENTAL_DAILY: "/environmental/daily",
} as const;

const FCM_TOPIC = "smart-pill-organizer";
const DAILY_DATA_RETENTION_DAYS = 20;

const NOTIFICATION_TITLES = {
  pill_reminder: "💊 Pill Reminder",
  environment_alert: "🌡️ Environment Alert",
} as const;

// ============================================================================
// Helper Functions - Validation
// ============================================================================

/**
 * Validates if the given data is a valid NotificationData object.
 * @param {unknown} data - The data to validate.
 * @return {boolean} True if data is valid NotificationData.
 */
function isValidNotification(data: unknown): data is NotificationData {
  if (!data || typeof data !== "object") return false;

  const notification = data as Record<string, unknown>;
  const isValidType = notification.type === "pill_reminder" ||
    notification.type === "environment_alert";

  return (
    isValidType &&
    typeof notification.message === "string" &&
    notification.message.length > 0 &&
    typeof notification.timestamp === "number"
  );
}

/**
 * Validates if the given data is a valid EnvironmentalReading object.
 * @param {unknown} data - The data to validate.
 * @return {boolean} True if data is valid EnvironmentalReading.
 */
function isValidReading(data: unknown): data is EnvironmentalReading {
  if (!data || typeof data !== "object") return false;

  const reading = data as Record<string, unknown>;

  return (
    typeof reading.temperature === "number" &&
    typeof reading.humidity === "number" &&
    typeof reading.timestamp === "number"
  );
}

// ============================================================================
// Helper Functions - Database Operations
// ============================================================================

/**
 * Fetches the device configuration from the database.
 * @return {Promise<DeviceConfig | null>} The device config or null.
 */
async function getDeviceConfig(): Promise<DeviceConfig | null> {
  try {
    const snapshot = await admin
      .database()
      .ref(DB_PATHS.DEVICE_CONFIG)
      .once("value");

    const config = snapshot.val();

    if (!config) {
      console.warn("Device config not found in database");
      return null;
    }

    return config;
  } catch (error) {
    console.error("Error fetching device config:", error);
    return null;
  }
}

/**
 * Updates the notification status in the database.
 * @param {admin.database.Reference} ref - The database reference.
 * @param {Partial<NotificationData>} updates - The updates to apply.
 * @return {Promise<void>}
 */
async function updateNotificationStatus(
  ref: admin.database.Reference,
  updates: Partial<NotificationData>
): Promise<void> {
  try {
    await ref.update(updates);
  } catch (error) {
    console.error("Error updating notification status:", error);
    throw error;
  }
}

// ============================================================================
// Helper Functions - Environmental Data
// ============================================================================

/**
 * Calculates daily aggregates from environmental readings.
 * @param {EnvironmentalReading[]} readings - Array of readings.
 * @return {Omit<DailyEnvironmentalData, "date">} The aggregates.
 */
function calculateDailyAggregates(
  readings: EnvironmentalReading[]
): Omit<DailyEnvironmentalData, "date"> {
  const temperatures = readings.map((r) => r.temperature);
  const humidities = readings.map((r) => r.humidity);

  const tempSum = temperatures.reduce((sum, val) => sum + val, 0);
  const tempAvg = tempSum / temperatures.length;
  const humiditySum = humidities.reduce((sum, val) => sum + val, 0);
  const humidityAvg = humiditySum / humidities.length;

  return {
    tempMin: Math.min(...temperatures),
    tempMax: Math.max(...temperatures),
    tempAvg: Math.round(tempAvg * 100) / 100,
    humidityMin: Math.min(...humidities),
    humidityMax: Math.max(...humidities),
    humidityAvg: Math.round(humidityAvg * 100) / 100,
  };
}

/**
 * Builds an alert message when environmental thresholds are exceeded.
 * @param {EnvironmentalReading} reading - The environmental reading.
 * @param {DeviceConfig} config - The device configuration.
 * @return {string} The alert message or empty string.
 */
function buildEnvironmentalAlertMessage(
  reading: EnvironmentalReading,
  config: DeviceConfig
): string {
  const alerts: string[] = [];

  // Check temperature thresholds
  if (reading.temperature < config.tempMin) {
    alerts.push(
      `Temperature too low: ${reading.temperature}°C (Min: ${config.tempMin}°C)`
    );
  } else if (reading.temperature > config.tempMax) {
    alerts.push(
      `Temperature too high: ${reading.temperature}°C ` +
      `(Max: ${config.tempMax}°C)`
    );
  }

  // Check humidity thresholds
  if (reading.humidity < config.humidityMin) {
    alerts.push(
      `Humidity too low: ${reading.humidity}% (Min: ${config.humidityMin}%)`
    );
  } else if (reading.humidity > config.humidityMax) {
    alerts.push(
      `Humidity too high: ${reading.humidity}% (Max: ${config.humidityMax}%)`
    );
  }

  return alerts.join(" | ");
}

/**
 * Gets the date range for a specific number of days ago in Tashkent timezone.
 * Returns Unix timestamps in MILLISECONDS to match database keys.
 * @param {number} daysAgo - Number of days in the past.
 * @return {{startKey: string, endKey: string, dateStr: string}} The date range.
 */
function getDateRange(daysAgo: number): {
  startKey: string;
  endKey: string;
  dateStr: string;
} {
  // Use Tashkent timezone (UTC+5) for consistency with the schedule
  const now = new Date();
  const tashkentOffset = 5 * 60; // UTC+5 in minutes
  const localOffset = now.getTimezoneOffset(); // in minutes
  const tashkentTime = new Date(now.getTime() +
    (tashkentOffset + localOffset) * 60 * 1000);

  // Go back the specified number of days
  tashkentTime.setDate(tashkentTime.getDate() - daysAgo);

  // Format as YYYY-MM-DD
  const year = tashkentTime.getFullYear();
  const month = String(tashkentTime.getMonth() + 1).padStart(2, "0");
  const day = String(tashkentTime.getDate()).padStart(2, "0");
  const dateStr = `${year}-${month}-${day}`;

  // Calculate Unix timestamps for start and end of day (in Tashkent time)
  const startOfDay = new Date(tashkentTime);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(tashkentTime);
  endOfDay.setHours(23, 59, 59, 999);

  // Convert back to UTC timestamps (in MILLISECONDS)
  const startUtc = startOfDay.getTime() -
    (tashkentOffset + localOffset) * 60 * 1000;
  const endUtc = endOfDay.getTime() -
    (tashkentOffset + localOffset) * 60 * 1000;

  // Return as strings for orderByKey() comparison
  const startKey = startUtc.toString();
  const endKey = endUtc.toString();

  return {startKey, endKey, dateStr};
}

// ============================================================================
// Cloud Functions - Notifications
// ============================================================================

export const sendPillReminderNotification = functions.database
  .ref(`${DB_PATHS.NOTIFICATIONS}/{notificationId}`)
  .onCreate(async (snapshot, context) => {
    const notificationData = snapshot.val();
    const notificationId = context.params.notificationId as string;

    // Validate notification data
    if (!isValidNotification(notificationData)) {
      console.error(
        "Invalid notification data:",
        {notificationId, data: notificationData}
      );
      await updateNotificationStatus(snapshot.ref, {
        delivered: false,
        error: "Invalid notification data",
      }).catch(() => {
        // Silently fail status update
      });
      return null;
    }

    // Get device config
    const config = await getDeviceConfig();
    if (!config) {
      console.error(
        "Config unavailable, cannot send notification:",
        notificationId
      );
      await updateNotificationStatus(snapshot.ref, {
        error: "Config unavailable",
      }).catch(() => {
        // Silently fail status update
      });
      return null;
    }

    // Check if push notifications are enabled
    if (!config.pushNotificationsEnabled) {
      console.log("Push notifications disabled:", notificationId);
      await updateNotificationStatus(snapshot.ref, {
        delivered: false,
        skipped: true,
        skipReason: "Push notifications disabled",
      }).catch(() => {
        // Silently fail status update
      });
      return null;
    }

    // Prepare and send FCM message
    const message = {
      notification: {
        title: NOTIFICATION_TITLES[notificationData.type],
        body: notificationData.message,
      },
      data: {
        notificationId,
        type: notificationData.type,
        timestamp: notificationData.timestamp.toString(),
      },
      topic: FCM_TOPIC,
    };

    try {
      const response = await admin.messaging().send(message);
      console.log(
        "Notification sent successfully:",
        {notificationId, response}
      );

      const timestamp =
        admin.database.ServerValue.TIMESTAMP as unknown as number;
      await updateNotificationStatus(snapshot.ref, {
        delivered: true,
        deliveredAt: timestamp,
      }).catch((error) => {
        console.error("Failed to update delivery status:", error);
      });

      return null;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(
        "Failed to send notification:",
        {notificationId, error: errorMessage}
      );

      const lastAttempt =
        admin.database.ServerValue.TIMESTAMP as unknown as number;
      await updateNotificationStatus(snapshot.ref, {
        delivered: false,
        error: errorMessage,
        lastAttemptAt: lastAttempt,
      }).catch(() => {
        // Silently fail status update
      });

      return null;
    }
  });

// ============================================================================
// Cloud Functions - Environmental Monitoring
// ============================================================================

export const checkEnvironmentalThresholds = functions.database
  .ref(`${DB_PATHS.ENVIRONMENTAL_HOURLY}/{timestamp}`)
  .onCreate(async (snapshot) => {
    const readingData = snapshot.val();

    // Validate reading data
    if (!isValidReading(readingData)) {
      console.error("Invalid environmental reading data:", readingData);
      return null;
    }

    // Get device config
    const config = await getDeviceConfig();
    if (!config) {
      console.error("Config unavailable, cannot check thresholds");
      return null;
    }

    // Build alert message if thresholds are exceeded
    const alertMessage = buildEnvironmentalAlertMessage(readingData, config);

    if (!alertMessage) {
      return null; // No thresholds exceeded
    }

    // Create notification entry
    const notification: NotificationData = {
      type: "environment_alert",
      message: alertMessage,
      timestamp: readingData.timestamp,
      delivered: false,
    };

    try {
      const newNotificationRef = await admin
        .database()
        .ref(DB_PATHS.NOTIFICATIONS)
        .push(notification);

      console.log("Environment alert created:", {
        notificationId: newNotificationRef.key,
        message: alertMessage,
      });

      return null;
    } catch (error) {
      console.error("Failed to create notification:", error);
      return null;
    }
  });

// ============================================================================
// Cloud Functions - Data Aggregation
// ============================================================================

export const aggregateDailyEnvironmentalData = functions.pubsub
  .schedule("0 0 * * *")
  .timeZone("Asia/Tashkent")
  .onRun(async () => {
    const {startKey, endKey, dateStr} = getDateRange(1); // Yesterday's data

    console.log(`Starting daily aggregation for ${dateStr}`);
    console.log(`Querying keys from ${startKey} to ${endKey}`);

    try {
      // Fetch hourly readings from yesterday (using ISO string keys)
      const hourlySnapshot = await admin
        .database()
        .ref(DB_PATHS.ENVIRONMENTAL_HOURLY)
        .orderByKey()
        .startAt(startKey)
        .endAt(endKey)
        .once("value");

      const hourlyData = hourlySnapshot.val();

      if (!hourlyData) {
        console.log(`No hourly data found for ${dateStr}`);
        return null;
      }

      const readings: EnvironmentalReading[] = Object.values(hourlyData);

      if (readings.length === 0) {
        console.log(`No valid readings for ${dateStr}`);
        return null;
      }

      // Calculate aggregates
      const aggregates = calculateDailyAggregates(readings);
      const dailyData: DailyEnvironmentalData = {
        ...aggregates,
        date: dateStr,
      };

      // Save daily summary
      await admin
        .database()
        .ref(`${DB_PATHS.ENVIRONMENTAL_DAILY}/${dateStr}`)
        .set(dailyData);

      console.log(`Daily aggregation completed for ${dateStr}:`, dailyData);

      // Clean up old data
      await cleanupOldDailyData();

      return null;
    } catch (error) {
      console.error("Error during daily aggregation:", error);
      return null;
    }
  });

// ============================================================================
// Helper Functions - Data Cleanup
// ============================================================================

/**
 * Cleans up daily environmental data older than retention period.
 * @return {Promise<void>}
 */
async function cleanupOldDailyData(): Promise<void> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - DAILY_DATA_RETENTION_DAYS);
    const cutoffDateStr = cutoffDate.toISOString().split("T")[0];

    console.log(`Cleaning up daily data older than ${cutoffDateStr}`);

    const dailySnapshot = await admin
      .database()
      .ref(DB_PATHS.ENVIRONMENTAL_DAILY)
      .orderByKey()
      .endAt(cutoffDateStr)
      .once("value");

    const oldData = dailySnapshot.val();

    if (!oldData) {
      console.log("No old daily data to clean up");
      return;
    }

    const dateKeys = Object.keys(oldData);

    if (dateKeys.length === 0) {
      console.log("No old daily data to clean up");
      return;
    }

    // Build batch delete updates
    const updates: Record<string, null> = {};
    dateKeys.forEach((dateKey) => {
      updates[`${DB_PATHS.ENVIRONMENTAL_DAILY}/${dateKey}`] = null;
    });

    await admin.database().ref().update(updates);
    console.log(`Deleted ${dateKeys.length} old daily records`);
  } catch (error) {
    console.error("Error cleaning up old daily data:", error);
  }
}
