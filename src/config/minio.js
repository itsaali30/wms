const Minio = require('minio');

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT) || 9000,
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'admin',
  secretKey: process.env.MINIO_SECRET_KEY || 'admin123'
});

const BUCKETS = {
  ATTENDANCE: 'wms-attendance',
  DAMAGES: 'wms-damages',
  STAGING: 'wms-staging',
  DOCUMENTS: 'user-documents'
};

async function ensureBucket(bucket) {
  try {
    const exists = await minioClient.bucketExists(bucket);
    if (!exists) {
      await minioClient.makeBucket(bucket);
      console.log(`✅ MinIO Bucket created: ${bucket}`);
    }
    // Set public read policy so images can be previewed on the dashboard
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucket}/*`]
        }
      ]
    };
    await minioClient.setBucketPolicy(bucket, JSON.stringify(policy));
  } catch (err) {
    console.warn(`MinIO warning for ${bucket}:`, err.message);
  }
}

async function initMinio() {
  for (const b of Object.values(BUCKETS)) {
    await ensureBucket(b);
  }
}

initMinio();

module.exports = { minioClient, BUCKETS };
