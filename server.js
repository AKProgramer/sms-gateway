// server.js
const express = require('express');
const admin = require('firebase-admin');
const EventEmitter = require('events');

// Initialize Express
const app = express();
app.use(express.json());


const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert({
    project_id: serviceAccount.project_id,
    client_email: serviceAccount.client_email,
    private_key: serviceAccount.private_key.replace(/\\n/g, '\n')
  })
});;

// Initialize Firestore
const db = admin.firestore();
const devicesCollection = db.collection('devices');
const webhooksCollection = db.collection('webhooks');

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
 * Register webhook URL for user
 * POST /register-webhook
 * Body: {
 *   userId: string,
 *   webhookUrl: string,
 *   events: string[] ('sms:sent', 'sms:received', etc.)
 * }
 */
app.post('/register-webhook', async (req, res) => {
  try {
    const { userId, webhookUrl, events } = req.body;

    if (!userId || !webhookUrl || !events || !Array.isArray(events)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userId, webhookUrl, events (array)'
      });
    }

    // Validate webhook URL format
    try {
      new URL(webhookUrl);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid webhookUrl format'
      });
    }

    // Create unique webhook ID
    const webhookId = `${userId}_${Date.now()}`;

    // Save webhook to Firestore
    await webhooksCollection.doc(webhookId).set({
      userId: userId,
      webhookUrl: webhookUrl,
      events: events,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Webhook registered: ${webhookId} for user ${userId}`);

    res.status(200).json({
      success: true,
      message: 'Webhook registered successfully',
      webhookId: webhookId
    });

  } catch (error) {
    console.error('Error registering webhook:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Unregister webhook URL
 * POST /unregister-webhook
 * Body: {
 *   webhookId: string
 * }
 */
app.post('/unregister-webhook', async (req, res) => {
  try {
    const { webhookId } = req.body;

    if (!webhookId) {
      return res.status(400).json({
        success: false,
        error: 'Missing webhookId'
      });
    }

    const webhookDoc = await webhooksCollection.doc(webhookId).get();
    if (!webhookDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Webhook not found'
      });
    }

    await webhooksCollection.doc(webhookId).delete();

    console.log(`Webhook unregistered: ${webhookId}`);

    res.status(200).json({
      success: true,
      message: 'Webhook unregistered successfully'
    });

  } catch (error) {
    console.error('Error unregistering webhook:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get user's registered webhooks
 * GET /webhooks/:userId
 */
app.get('/webhooks/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing userId'
      });
    }

    const query = webhooksCollection.where('userId', '==', userId).where('active', '==', true);
    const snapshot = await query.get();

    const webhooks = [];
    snapshot.forEach(doc => {
      webhooks.push({
        webhookId: doc.id,
        ...doc.data()
      });
    });

    res.status(200).json({
      success: true,
      count: webhooks.length,
      webhooks: webhooks
    });

  } catch (error) {
    console.error('Error fetching webhooks:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Helper function to send webhook logs to registered URLs
 * @param {string} userId - User ID
 * @param {object} logData - Log data object
 * @param {string} eventType - Event type ('sms:sent', 'sms:received', etc.)
 */
async function sendWebhookLogs(userId, logData, eventType) {
  try {
    const query = webhooksCollection
      .where('userId', '==', userId)
      .where('active', '==', true);
    
    const snapshot = await query.get();

    if (snapshot.empty) {
      console.log(`No webhooks found for user ${userId}`);
      return;
    }

    const webhookRequests = [];

    snapshot.forEach(doc => {
      const webhook = doc.data();

      // Check if webhook is subscribed to this event
      if (webhook.events.includes(eventType)) {
        const payload = {
          event: eventType,
          timestamp: new Date().toISOString(),
          data: logData
        };

        // Send POST request to webhook URL with timeout
        const request = fetch(webhook.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Event': eventType,
            'X-Webhook-Id': doc.id
          },
          body: JSON.stringify(payload)
        })
          .then(response => {
            if (!response.ok) {
              console.warn(`Webhook ${doc.id} responded with status ${response.status}`);
            } else {
              console.log(`Webhook ${doc.id} delivered successfully`);
            }
          })
          .catch(error => {
            console.error(`Error sending webhook ${doc.id}:`, error.message);
            // Optionally: Mark webhook as failed or inactive after multiple failures
          });

        webhookRequests.push(request);
      }
    });

    // Fire and forget - don't wait for all webhooks to complete
    Promise.all(webhookRequests).catch(error => {
      console.error('Error in webhook batch processing:', error);
    });

  } catch (error) {
    console.error('Error in sendWebhookLogs:', error);
  }
}

/**
 * Send SMS log to registered webhooks
 * POST /send-webhook-logs
 * Body: {
 *   userId: string,
 *   id: string,
 *   recipient: string,
 *   message: string,
 *   status: 'sent' | 'delivered' | 'failed' | 'received',
 *   type: 'sms:sent' | 'sms:received',
 *   timestamp: string (ISO 8601)
 * }
 */
app.post('/send-webhook-logs', async (req, res) => {
  try {
    const { userId, id, recipient, message, status, type, timestamp } = req.body;

    if (!userId || !id || !recipient || !message || !status || !type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userId, id, recipient, message, status, type'
      });
    }

    // Validate event type
    const validEventTypes = ['sms:sent', 'sms:received'];
    if (!validEventTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid type. Must be one of: ${validEventTypes.join(', ')}`
      });
    }

    const logData = {
      id: id,
      recipient: recipient,
      message: message,
      status: status,
      timestamp: timestamp || new Date().toISOString(),
      type: type
    };

    // Send to webhooks asynchronously
    sendWebhookLogs(userId, logData, type);

    res.status(202).json({
      success: true,
      message: 'Webhook logs queued for delivery',
      data: logData
    });

  } catch (error) {
    console.error('Error sending webhook logs:', error);
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