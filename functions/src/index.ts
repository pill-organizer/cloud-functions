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
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const NOTIFICATION_TITLES = {
  pill_reminder: "💊 Pill Reminder",
  environment_alert: "🌡️ Environment Alert",
} as const;

// ============================================================================
// Helper Functions - Validation
// ============================================================================

function isValidNotification(data: unknown): data is NotificationData {
  if (!data || typeof data !== "object") return false;
  
  const notification = data as Record<string, unknown>;
  
  return (
    (notification.type === "pill_reminder" || notification.type === "environment_alert") &&
    typeof notification.message === "string" &&
    notification.message.length > 0 &&
    typeof notification.timestamp === "number"
  );
}

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

function calculateDailyAggregates(
  readings: EnvironmentalReading[]
): Omit<DailyEnvironmentalData, "date"> {
  const temperatures = readings.map((r) => r.temperature);
  const humidities = readings.map((r) => r.humidity);

  const tempAvg = temperatures.reduce((sum, val) => sum + val, 0) / temperatures.length;
  const humidityAvg = humidities.reduce((sum, val) => sum + val, 0) / humidities.length;

  return {
    tempMin: Math.min(...temperatures),
    tempMax: Math.max(...temperatures),
    tempAvg: Math.round(tempAvg * 100) / 100,
    humidityMin: Math.min(...humidities),
    humidityMax: Math.max(...humidities),
    humidityAvg: Math.round(humidityAvg * 100) / 100,
  };
}

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
      `Temperature too high: ${reading.temperature}°C (Max: ${config.tempMax}°C)`
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

function getDateRange(daysAgo: number): { start: number; end: number; dateStr: string } {
  const targetDate = new Date(Date.now() - daysAgo * MILLISECONDS_PER_DAY);
  const dateStr = targetDate.toISOString().split("T")[0];
  
  const start = new Date(targetDate.setHours(0, 0, 0, 0)).getTime();
  const end = new Date(targetDate.setHours(23, 59, 59, 999)).getTime();

  return { start, end, dateStr };
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
      console.error("Invalid notification data:", { notificationId, data: notificationData });
      await updateNotificationStatus(snapshot.ref, {
        delivered: false,
        error: "Invalid notification data",
      }).catch(() => {}); // Silently fail status update
      return null;
    }

    // Get device config
    const config = await getDeviceConfig();
    if (!config) {
      console.error("Config unavailable, cannot send notification:", notificationId);
      await updateNotificationStatus(snapshot.ref, {
        error: "Config unavailable",
      }).catch(() => {});
      return null;
    }

    // Check if push notifications are enabled
    if (!config.pushNotificationsEnabled) {
      console.log("Push notifications disabled:", notificationId);
      await updateNotificationStatus(snapshot.ref, {
        delivered: false,
        skipped: true,
        skipReason: "Push notifications disabled",
      }).catch(() => {});
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
      console.log("Notification sent successfully:", { notificationId, response });

      await updateNotificationStatus(snapshot.ref, {
        delivered: true,
        deliveredAt: admin.database.ServerValue.TIMESTAMP as unknown as number,
      }).catch((error) => {
        console.error("Failed to update delivery status:", error);
      });

      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to send notification:", { notificationId, error: errorMessage });

      await updateNotificationStatus(snapshot.ref, {
        delivered: false,
        error: errorMessage,
        lastAttemptAt: admin.database.ServerValue.TIMESTAMP as unknown as number,
      }).catch(() => {});

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
    const { start, end, dateStr } = getDateRange(1); // Yesterday's data

    console.log(`Starting daily aggregation for ${dateStr}`);

    try {
      // Fetch hourly readings from yesterday
      const hourlySnapshot = await admin
        .database()
        .ref(DB_PATHS.ENVIRONMENTAL_HOURLY)
        .orderByKey()
        .startAt(start.toString())
        .endAt(end.toString())
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