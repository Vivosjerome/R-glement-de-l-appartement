import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();

console.log("\nColle ces deux lignes dans ton fichier .env :\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}\n`);
console.log("Garde la cle privee secrete. Si tu la changes, tout le monde");
console.log("devra reactiver les notifications depuis l'app.\n");
