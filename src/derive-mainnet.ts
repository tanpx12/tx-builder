// Derive EVM and Stellar addresses using NEAR mainnet MPC signer
import { connect, keyStores } from "near-api-js";
import type { ConnectConfig } from "near-api-js";
import { publicKeyToEvmAddress, publicKeyToStellarAddress } from "./derive.js";

const MAINNET_CONTRACT_ID = "8fa7217570eb2766d2328a819098acf5e7a116c2d4d5c4d7823fccd83ec0556e";
const MAINNET_MPC_CONTRACT_ID = "v1.signer";
const MAINNET_RPC_URL = "https://rpc.fastnear.com";

// Base58 decode (no checksum)
function bs58Decode(str: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let result = BigInt(0);
  for (const char of str) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 char: ${char}`);
    result = result * BigInt(58) + BigInt(idx);
  }
  const hex = result.toString(16);
  const bytes = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  let leadingZeros = 0;
  for (const c of str) {
    if (c === "1") leadingZeros++;
    else break;
  }
  return Uint8Array.from([...new Uint8Array(leadingZeros), ...bytes]);
}

function parseMpcPublicKey(raw: string): string {
  const parts = raw.split(":");
  const keyPart = parts[parts.length - 1];
  if (!keyPart) throw new Error("Invalid MPC public key format");
  const keyBytes = bs58Decode(keyPart);
  if (keyBytes.length === 64) {
    return "04" + Buffer.from(keyBytes).toString("hex");
  }
  return Buffer.from(keyBytes).toString("hex");
}

async function main() {
  const keyStore = new keyStores.InMemoryKeyStore();
  const near = await connect({
    networkId: "mainnet",
    nodeUrl: MAINNET_RPC_URL,
    keyStore,
  } as ConnectConfig);

  const account = await near.account(MAINNET_CONTRACT_ID);

  // Build derivation paths: "<contract_id>,<owner>,<chain>,<index>"
  const ethPath = `${MAINNET_CONTRACT_ID},${MAINNET_CONTRACT_ID},ethereum,0`;
  const stellarPath = `${MAINNET_CONTRACT_ID},${MAINNET_CONTRACT_ID},stellar,0`;

  console.log("Derivation paths:");
  console.log("  EVM:", ethPath);
  console.log("  Stellar:", stellarPath);

  // Fetch derived public keys from mainnet MPC signer
  const evmDerivedRaw: string = await account.viewFunction({
    contractId: MAINNET_MPC_CONTRACT_ID,
    methodName: "derived_public_key",
    args: { path: ethPath, predecessor: MAINNET_CONTRACT_ID },
  });
  console.log("\nMPC derived EVM key:", evmDerivedRaw);
  const evmChildHex = parseMpcPublicKey(evmDerivedRaw);

  const stellarDerivedRaw: string = await account.viewFunction({
    contractId: MAINNET_MPC_CONTRACT_ID,
    methodName: "derived_public_key",
    args: { path: stellarPath, predecessor: MAINNET_CONTRACT_ID },
  });
  console.log("MPC derived Stellar key:", stellarDerivedRaw);
  const stellarChildHex = parseMpcPublicKey(stellarDerivedRaw);

  // Derive addresses
  const evmAddress = publicKeyToEvmAddress(evmChildHex);
  const stellar = publicKeyToStellarAddress(stellarChildHex);

  console.log("\n========== Mainnet Derived Addresses ==========");
  console.log("EVM Address:", evmAddress);
  console.log("Stellar Address:", stellar.address);
  console.log("Stellar Ed25519 Public Key (hex):", stellar.ed25519PublicKeyHex);
}

main().catch(console.error);
