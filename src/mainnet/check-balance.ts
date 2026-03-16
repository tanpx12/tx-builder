// Quick check of Stellar balances via Soroban RPC
import "dotenv/config";
import { rpc, nativeToScVal, Address as StellarAddress, xdr } from "@stellar/stellar-sdk";
import { STELLAR_SOROBAN_RPC, STELLAR_USDC_TOKEN, STELLAR_XLM_TOKEN } from "./config.js";
import { deriveMainnetAddresses } from "./near.js";

function decodeI128(val: xdr.ScVal): bigint {
  const i128 = val.value() as { hi: () => any; lo: () => any };
  return (BigInt(i128.hi().toString()) << 64n) | BigInt(i128.lo().toString());
}

async function main() {
  const addrs = await deriveMainnetAddresses();
  console.log(`Stellar: ${addrs.stellar.address}`);

  const server = new rpc.Server(STELLAR_SOROBAN_RPC);
  const account = await server.getAccount(addrs.stellar.address);
  console.log(`Sequence: ${account.sequenceNumber()}`);

  // Query USDC balance via SAC contract
  for (const [token, label] of [[STELLAR_USDC_TOKEN, "USDC"], [STELLAR_XLM_TOKEN, "XLM"]] as const) {
    const { TransactionBuilder, Operation, Networks } = await import("@stellar/stellar-sdk");
    const tx = new TransactionBuilder(account, { fee: "100000", networkPassphrase: Networks.PUBLIC })
      .addOperation(Operation.invokeContractFunction({
        contract: token,
        function: "balance",
        args: [nativeToScVal(addrs.stellar.address, { type: "address" })],
      }))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      console.log(`${label}: sim error`);
    } else {
      const retval = (sim as any).result?.retval;
      if (retval) {
        const bal = decodeI128(retval);
        console.log(`${label}: ${Number(bal) / 1e7}`);
      }
    }
  }
}

main().catch(console.error);
