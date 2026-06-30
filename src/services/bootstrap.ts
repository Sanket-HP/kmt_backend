import { auth, db } from './db';

/**
 * Bootstraps the first administrator account if it doesn't already exist.
 * Uses environment variables BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD.
 */
export async function bootstrapAdmin() {
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.log("[Bootstrap Warning] BOOTSTRAP_ADMIN_EMAIL or BOOTSTRAP_ADMIN_PASSWORD environment variables are missing. Skipping admin bootstrapping.");
    return;
  }

  try {
    // 1. Check setting lock to prevent any recreation or overwrite
    const settingsRef = db.collection('settings').doc('bootstrap');
    const settingsSnap = await settingsRef.get();
    
    if (settingsSnap.exists && settingsSnap.data()?.adminInitialized) {
      console.log("[Bootstrap] Administrator account already initialized and locked. Skipping.");
      return;
    }

    // 2. Check Firebase Authentication
    try {
      const userRecord = await auth.getUserByEmail(adminEmail);
      console.log(`[Bootstrap] Admin account already exists in Auth: ${userRecord.email}. Locking initialization.`);
      await settingsRef.set({ adminInitialized: true }, { merge: true });
      return;
    } catch (authError: any) {
      if (authError.code !== 'auth/user-not-found') {
        throw authError;
      }
    }

    // 3. Create bootstrap admin in Firebase Authentication
    console.log(`[Bootstrap] Creating system administrator account: ${adminEmail}...`);
    const newUser = await auth.createUser({
      email: adminEmail,
      password: adminPassword,
      displayName: 'System Administrator'
    });

    // 4. Set custom claim role: "admin"
    await auth.setCustomUserClaims(newUser.uid, { role: 'admin', employeeId: 'ADM001' });
    console.log(`[Bootstrap] Role claims updated to "admin" for system administrator.`);

    // 5. Create user profile document in Firestore
    await db.collection('users').doc(newUser.uid).set({
      uid: newUser.uid,
      name: 'System Administrator',
      email: adminEmail,
      phone: '',
      role: 'admin',
      employeeId: 'ADM001',
      isActive: true,
      requirePasswordChange: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    console.log(`[Bootstrap] Firestore user document created at /users/${newUser.uid}`);

    // 6. Save bootstrap initialized flag
    await settingsRef.set({ adminInitialized: true }, { merge: true });
    console.log("[Bootstrap] Initialization successfully locked.");
  } catch (error: any) {
    console.error("[Bootstrap Error] Failed to complete system administrator bootstrapping:", error.message || error);
  }
}
