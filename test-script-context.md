Universal account (`../asset-manager/src/lib.rs`) has function to encode transaction payload for EVM and Stellar. 
Here are the list of encoding functions :
- `build_stellar_payment_payload`
- `build_stellar_raw_payload`
- `build_eth_eip7702_payload`
- `build_eth_eip1559_payload`
- `build_eth_legacy_payload`
Read these function, generate input and write TS script to generate expected output