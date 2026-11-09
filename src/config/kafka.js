const { Kafka } = require('kafkajs');
const EventEmitter = require('events');

class WarehouseEventBus extends EventEmitter {}
const eventBus = new WarehouseEventBus();

let producer = null;
const isKafkaEnabled = process.env.KAFKA_ENABLED === 'true';

if (isKafkaEnabled) {
  try {
    const kafka = new Kafka({
      clientId: 'wms-service',
      brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',')
    });
    producer = kafka.producer();
    producer.connect().then(() => {
      console.log('✅ Kafka Producer connected.');
    }).catch(err => {
      console.warn('⚠️ Kafka connection failed, falling back to local event bus:', err.message);
      producer = null;
    });
  } catch (err) {
    console.warn('⚠️ Kafka initialization error:', err.message);
  }
}

/**
 * Emit warehouse event (Kafka topic + internal event bus)
 * @param {string} topic e.g., 'wms.picking', 'wms.putaway', 'wms.inward', 'wms.packing', 'wms.attendance'
 * @param {object} payload
 */
async function emitWarehouseEvent(topic, payload) {
  const event = {
    topic,
    timestamp: new Date().toISOString(),
    payload
  };

  // Broadcast to local event bus for real-time socket propagation
  eventBus.emit(topic, event);
  eventBus.emit('*', event);

  // Send to Kafka if connected
  if (producer) {
    try {
      await producer.send({
        topic,
        messages: [{ value: JSON.stringify(event) }]
      });
    } catch (err) {
      console.warn(`⚠️ Kafka send error on topic ${topic}:`, err.message);
    }
  } else {
    // Log local stream message
    if (process.env.NODE_ENV !== 'test') {
      console.log(`📡 [WMS-EVENT] [${topic}]:`, payload.action || topic, payload.summary || '');
    }
  }
}

module.exports = { emitWarehouseEvent, eventBus };
