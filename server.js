// server.js
const express = require('express');
const admin = require('firebase-admin');
const EventEmitter = require('events');

// Initialize Express
const app = express();
app.use(express.json());

// Initialize Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Initialize Firestore
const db = admin.firestore();
const devicesCollection = db.collection('devices');

/**
 * Register device token
 * POST /register-device
 * Body: {
 *   deviceToken: string,
 *   userId: string,
 *   platform: 'android' | 'ios'
 * }
 */
app.post('/register-device', async (req, res) => {
  try {
    const { deviceToken, userId, platform } = req.body;

    if (!deviceToken || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing deviceToken or userId'
      });
    }

    // Save to Firestore
    await devicesCollection.doc(userId).set({
      token: deviceToken,
      platform: platform || 'unknown',
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Device registered: ${userId} - ${platform}`);

    res.status(200).json({
      success: true,
      message: 'Device token registered successfully'
    });

  } catch (error) {
    console.error('Error registering device:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Send SMS by userId (lookup token automatically)
 * POST /send-sms
 * Body: {
 *   userId: string,
 *   phoneNumber: string,
 *   message: string
 * }
 */
app.post('/send-sms', async (req, res) => {
  try {
    const { userId, phoneNumber, message } = req.body;

    if (!userId || !phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Get device token from Firestore
    const deviceDoc = await devicesCollection.doc(userId).get();
    
    if (!deviceDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Device token not found for user'
      });
    }

    const deviceData = deviceDoc.data();
    const deviceToken = deviceData.token;

    // Send FCM notification
    const fcmMessage = {
      token: deviceToken,
      data: {
        phone_number: phoneNumber,
        message: message,
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high'
      }
    };

    const response = await admin.messaging().send(fcmMessage);

    res.status(200).json({
      success: true,
      messageId: response,
      userId: userId
    });

  } catch (error) {
    console.error('Error sending SMS:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Event Emitter for SMS triggers
class SMSEventEmitter extends EventEmitter {}
const smsEmitter = new SMSEventEmitter();

// Listen for SMS send events (your custom logic goes here)
smsEmitter.on('sendSMS', async (data) => {
  console.log('SMS Event Triggered:', data);
  
  // TODO: Add your custom logic here
  // - Database logging
  // - Validation
  // - Rate limiting checks
  // - Analytics
});

/**
 * Send FCM notification to a specific device
 * POST /send-notification
 * Body: {
 *   userId: string,
 *   phoneNumber: string,
 *   message: string
 * }
 */
app.post('/send-notification', async (req, res) => {
  try {
    const { userId, phoneNumber, message } = req.body;

    if (!userId || !phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Get device token from Firestore
    const deviceDoc = await devicesCollection.doc(userId).get();
    
    if (!deviceDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Device token not found for user'
      });
    }

    const deviceData = deviceDoc.data();
    const deviceToken = deviceData.token;

    // Emit event before sending
    smsEmitter.emit('sendSMS', {
      deviceToken,
      phoneNumber,
      message,
      timestamp: new Date().toISOString()
    });

    // Prepare FCM message with data payload only (for background handling)
    const fcmMessage = {
      token: deviceToken,
      data: {
        phone_number: phoneNumber,
        message: message,
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high',
        notification: {
          title: 'SMS Send Request',
          body: `Sending SMS to ${phoneNumber}`,
          clickAction: 'FLUTTER_NOTIFICATION_CLICK'
        }
      }
    };

    // Send message via FCM
    const response = await admin.messaging().send(fcmMessage);

    console.log('Successfully sent message:', response);

    res.status(200).json({
      success: true,
      messageId: response,
      data: {
        phoneNumber,
        message
      }
    });

  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Send FCM notification to multiple devices
 * POST /send-notification-multiple
 * Body: {
 *   userIds: string[],
 *   phoneNumber: string,
 *   message: string
 * }
 */
app.post('/send-notification-multiple', async (req, res) => {
  try {
    const { userIds, phoneNumber, message } = req.body;

    if (!userIds || !Array.isArray(userIds) || !phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields or userIds is not an array'
      });
    }

    // Batch get device tokens from Firestore
    const devicePromises = userIds.map(userId => 
      devicesCollection.doc(userId).get()
    );
    const deviceDocs = await Promise.all(devicePromises);

    const tokens = [];
    deviceDocs.forEach((doc, idx) => {
      if (doc.exists) {
        tokens.push(doc.data().token);
      } else {
        console.warn(`Device token not found for userId: ${userIds[idx]}`);
      }
    });

    if (tokens.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No valid device tokens found for provided userIds'
      });
    }

    // Emit event
    smsEmitter.emit('sendSMS', {
      deviceTokens: tokens,
      phoneNumber,
      message,
      timestamp: new Date().toISOString()
    });

    // Prepare multicast message
    const multicastMessage = {
      tokens: tokens,
      data: {
        phone_number: phoneNumber,
        message: message,
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high'
      }
    };

    const response = await admin.messaging().sendEachForMulticast(multicastMessage);

    console.log('Multicast response:', response);

    res.status(200).json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses.map((resp, idx) => ({
        token: tokens[idx],
        success: resp.success,
        messageId: resp.messageId,
        error: resp.error?.message
      }))
    });

  } catch (error) {
    console.error('Error sending multicast message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Send to a topic (for broadcasting)
 * POST /send-to-topic
 * Body: {
 *   topic: string,
 *   phoneNumber: string,
 *   message: string
 * }
 */
app.post('/send-to-topic', async (req, res) => {
  try {
    const { topic, phoneNumber, message } = req.body;

    if (!topic || !phoneNumber || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: topic, phoneNumber, message'
      });
    }

    smsEmitter.emit('sendSMS', {
      topic,
      phoneNumber,
      message,
      timestamp: new Date().toISOString()
    });

    const topicMessage = {
      topic: topic,
      data: {
        phone_number: phoneNumber,
        message: message,
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high'
      }
    };

    const response = await admin.messaging().send(topicMessage);

    res.status(200).json({
      success: true,
      messageId: response
    });

  } catch (error) {
    console.error('Error sending to topic:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Subscribe device to a topic
 * POST /subscribe-to-topic
 * Body: {
 *   userIds: string[],
 *   topic: string
 * }
 */
app.post('/subscribe-to-topic', async (req, res) => {
  try {
    const { userIds, topic } = req.body;

    if (!userIds || !Array.isArray(userIds) || !topic) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields or userIds is not an array'
      });
    }

    // Batch get device tokens from Firestore
    const devicePromises = userIds.map(userId => 
      devicesCollection.doc(userId).get()
    );
    const deviceDocs = await Promise.all(devicePromises);

    const tokens = [];
    deviceDocs.forEach((doc, idx) => {
      if (doc.exists) {
        tokens.push(doc.data().token);
      } else {
        console.warn(`Device token not found for userId: ${userIds[idx]}`);
      }
    });

    if (tokens.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No valid device tokens found for provided userIds'
      });
    }

    const response = await admin.messaging().subscribeToTopic(tokens, topic);

    res.status(200).json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
      errors: response.errors
    });

  } catch (error) {
    console.error('Error subscribing to topic:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Unregister device token
 * POST /unregister-device
 * Body: {
 *   userId: string
 * }
 */
app.post('/unregister-device', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing userId'
      });
    }

    await devicesCollection.doc(userId).delete();

    res.status(200).json({
      success: true,
      message: 'Device token unregistered successfully'
    });

  } catch (error) {
    console.error('Error unregistering device:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FCM Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// Export for testing
module.exports = { app, smsEmitter };