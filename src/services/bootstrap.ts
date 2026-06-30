import { auth, db } from './db';

/**
 * Bootstraps and verifies the system administrator account on startup.
 * Automatically provisions the administrator, demotes any conflicting ADM001 profiles,
 * and repairs claims or Firestore documents if out of sync.
 */
export async function bootstrapAdmin() {
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  console.log("[Bootstrap] Loading Environment...");
  if (!adminEmail || !adminPassword) {
    console.warn("[Bootstrap Error] Missing Environment Variable: BOOTSTRAP_ADMIN_EMAIL or BOOTSTRAP_ADMIN_PASSWORD is not set.");
    return;
  }

  console.log(`[Bootstrap] Configured Email: ${adminEmail}`);

  try {
    const settingsRef = db.collection('settings').doc('bootstrap');
    const settingsSnap = await settingsRef.get();

    // 1. Check if the administrator exists in Firebase Authentication
    console.log("[Bootstrap] Checking Firebase Authentication...");
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(adminEmail);
      console.log("[Bootstrap] Administrator Found in Firebase Auth.");
    } catch (authError: any) {
      if (authError.code !== 'auth/user-not-found') {
        throw authError;
      }
    }

    // 2. Resolve Duplicate/Conflict ADM001 Employee ID
    // Any other user in Firestore who has employeeId === 'ADM001' but email !== adminEmail must be demoted
    const oldAdminQuery = await db.collection('users')
      .where('employeeId', '==', 'ADM001')
      .get();
    
    for (const doc of oldAdminQuery.docs) {
      const data = doc.data();
      if (data.email !== adminEmail) {
        console.log(`[Bootstrap] Deactivating and demoting conflicting ADM001 profile: ${data.email}`);
        await doc.ref.update({
          employeeId: `ADM001_OLD_${doc.id}`,
          role: 'passenger',
          isActive: false,
          updatedAt: Date.now()
        });
      }
    }

    let uid: string;
    if (!userRecord) {
      // Create user
      console.log(`[Bootstrap] Administrator Missing. Creating user account in Firebase Authentication...`);
      const newUser = await auth.createUser({
        email: adminEmail,
        password: adminPassword,
        displayName: 'System Administrator'
      });
      uid = newUser.uid;
      console.log(`[Bootstrap] Auth user created successfully. UID: ${uid}`);
    } else {
      uid = userRecord.uid;
    }

    // 3. Check and Repair Firestore Profile
    console.log("[Bootstrap] Checking Firestore...");
    const userDocRef = db.collection('users').doc(uid);
    const userDocSnap = await userDocRef.get();

    if (!userDocSnap.exists) {
      console.log(`[Bootstrap] Profile Missing. Creating Firestore profile document under /users/${uid}...`);
      await userDocRef.set({
        uid,
        name: 'System Administrator',
        email: adminEmail,
        employeeId: 'ADM001',
        role: 'admin',
        isActive: true,
        requirePasswordChange: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      console.log(`[Bootstrap] Firestore profile document created.`);
    } else {
      const data = userDocSnap.data()!;
      const repairs: any = {};
      
      if (data.role !== 'admin') repairs.role = 'admin';
      if (data.employeeId !== 'ADM001') repairs.employeeId = 'ADM001';
      if (data.isActive !== true) repairs.isActive = true;
      if (data.email !== adminEmail) repairs.email = adminEmail;
      if (data.name !== 'System Administrator' && !data.name) repairs.name = 'System Administrator';

      if (Object.keys(repairs).length > 0) {
        console.log(`[Bootstrap] Profile Incomplete. Repairing fields: ${JSON.stringify(repairs)}...`);
        await userDocRef.update({
          ...repairs,
          updatedAt: Date.now()
        });
        console.log("[Bootstrap] Profile Repaired Successfully.");
      } else {
        console.log("[Bootstrap] Profile Found & Verified.");
      }
    }

    // 4. Check and Repair Custom Claims
    console.log("[Bootstrap] Checking Claims...");
    const userAuthRecord = await auth.getUser(uid);
    const claims = userAuthRecord.customClaims || {};
    
    if (claims.role !== 'admin' || claims.employeeId !== 'ADM001') {
      console.log("[Bootstrap] Claims Incomplete. Repairing custom claims...");
      await auth.setCustomUserClaims(uid, {
        role: 'admin',
        employeeId: 'ADM001'
      });
      console.log("[Bootstrap] Claims Repaired Successfully.");
    } else {
      console.log("[Bootstrap] Claims Verified.");
    }

    // 5. Update /settings/bootstrap Settings Lock Document
    await settingsRef.set({
      bootstrapVersion: '2.0.0',
      configuredAdminEmail: adminEmail,
      lastVerified: Date.now(),
      lastRepair: Date.now(),
      createdByBootstrap: true
    }, { merge: true });

    console.log("[Bootstrap] Bootstrap Complete. System Administrator is fully functional.");
  } catch (error: any) {
    console.error("[Bootstrap Error] Bootstrap Failure:", error.message || error);
  }
}
