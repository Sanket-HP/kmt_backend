import * as admin from 'firebase-admin';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

const envFile = `.env.${process.env.NODE_ENV || 'development'}`;
const envPath = path.resolve(process.cwd(), envFile);
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(`[Env Loader] Loaded environment config: ${envFile}`);
} else {
  const rootEnvPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(rootEnvPath)) {
    dotenv.config({ path: rootEnvPath });
    console.log("[Env Loader] Loaded default root environment config.");
  } else {
    dotenv.config();
    console.log("[Env Loader] Loaded default fallback config.");
  }
}

const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || 'kmt-connect';

if (admin.apps.length === 0) {
  try {
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (serviceAccountBase64) {
      const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId
      });
      console.log("[Firebase Admin] Initialized successfully via Service Account Credential.");
    } else {
      admin.initializeApp({
        projectId
      });
      console.log(`[Firebase Admin] Initialized fallback using Project ID: ${projectId}`);
    }
  } catch (e) {
    console.error("[Firebase Admin] Initialization failed:", e);
  }
}

export const db = admin.firestore();
export const auth = admin.auth();
export const FieldValue = admin.firestore.FieldValue;
