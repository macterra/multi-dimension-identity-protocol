/* eslint-disable operator-linebreak */
/* eslint-disable prefer-template */
/* eslint-disable no-bitwise */
const bech32 = require('bech32');
const promisifiedRequests = require('./promisifiedReq');

const MAGIC_BTC_MAINNET = 0x03;
const MAGIC_BTC_MAINNET_EXTENDED = 0x04;
const MAGIC_BTC_TESTNET = 0x06;
const MAGIC_BTC_TESTNET_EXTENDED = 0x07;

const TXREF_BECH32_HRP_MAINNET = 'tx';
const TXREF_BECH32_HRP_TESTNET = 'txtest';

const CHAIN_MAINNET = 'mainnet';
const CHAIN_TESTNET = 'testnet';

const txrefEncode = (chain, blockHeight, txPos, utxoIndex) => {
  const prefix =
    chain === CHAIN_MAINNET
      ? TXREF_BECH32_HRP_MAINNET
      : TXREF_BECH32_HRP_TESTNET;
  // const nonStandard = chain !== CHAIN_MAINNET;
  const extendedTxref = utxoIndex !== undefined;

  let magic;
  if (extendedTxref) {
    magic =
      chain === CHAIN_MAINNET
        ? MAGIC_BTC_MAINNET_EXTENDED
        : MAGIC_BTC_TESTNET_EXTENDED;
  } else {
    magic = chain === CHAIN_MAINNET ? MAGIC_BTC_MAINNET : MAGIC_BTC_TESTNET;
  }

  let shortId;
  if (extendedTxref) {
    shortId = [
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]; // 12
  } else {
    shortId = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]; // 9
  }

  if (blockHeight > 0xffffff || txPos > 0x7fff || magic > 0x1f) {
    return null;
  }

  if (extendedTxref && utxoIndex > 0x7fff) {
    return null;
  }

  /* set the magic */
  shortId[0] = magic;

  /* make sure the version bit is 0 */
  shortId[1] &= ~(1 << 0);

  shortId[1] |= (blockHeight & 0xf) << 1;
  shortId[2] |= (blockHeight & 0x1f0) >> 4;
  shortId[3] |= (blockHeight & 0x3e00) >> 9;
  shortId[4] |= (blockHeight & 0x7c000) >> 14;
  shortId[5] |= (blockHeight & 0xf80000) >> 19;

  shortId[6] |= txPos & 0x1f;
  shortId[7] |= (txPos & 0x3e0) >> 5;
  shortId[8] |= (txPos & 0x7c00) >> 10;

  if (extendedTxref) {
    shortId[9] |= utxoIndex & 0x1f;
    shortId[10] |= (utxoIndex & 0x3e0) >> 5;
    shortId[11] |= (utxoIndex & 0x7c00) >> 10;
  }

  const result = bech32.encode(prefix, shortId);

  const origLength = result.length;
  const breakIndex = prefix.length + 1;
  let finalResult =
    result.substring(0, breakIndex) +
    ':' +
    result.substring(breakIndex, breakIndex + 4) +
    '-' +
    result.substring(breakIndex + 4, breakIndex + 8) +
    '-' +
    result.substring(breakIndex + 8, breakIndex + 12) +
    '-';
  if (origLength - breakIndex < 16) {
    finalResult += result.substring(breakIndex + 12, result.length);
  } else {
    finalResult +=
      result.substring(breakIndex + 12, breakIndex + 16) +
      '-' +
      result.substring(breakIndex + 16, result.length);
  }

  return finalResult;
};

const parseTxDetails = (txData, chain, txid, utxoIndex) => {
  const blockHash = txData.block_hash;
  const blockHeight = txData.block_height;
  const blockIndex = txData.block_index;
  const { fees } = txData;
  const inputs = txData.inputs.map((x) => ({
    script: x.script,
    addresses: x.addresses,
    outputValue: x.output_value,
    previousHash: x.prev_hash,
  }));
  const outputs = txData.outputs.map((x) => {
    if (x.value === 0) {
      return {
        script: x.script,
        dataHex: x.data_hex,
        dataString: x.data_string,
        outputValue: x.value,
        scriptType: x.script_type,
      };
    }
    return {
      script: x.script,
      addresses: x.addresses,
      outputValue: x.value,
      scriptType: x.script_type,
    };
  });
  return {
    blockHash,
    blockHeight,
    blockIndex,
    txReceived: txData.received,
    txConfirmed: txData.confirmed,
    numConfirmations: txData.confirmations,
    inputs,
    outputs,
    chain,
    fees,
    txHash: txid,
    utxoIndex,
  };
};

function getTxDetails(txid, chain, utxoIndex) {
  let theUrl;
  if (chain === CHAIN_MAINNET) {
    theUrl = `https://api.blockcypher.com/v1/btc/main/txs/${txid}?limit=500`;
  } else {
    theUrl = `https://api.blockcypher.com/v1/btc/test3/txs/${txid}?limit=500`;
  }

  return promisifiedRequests.request({ url: theUrl }).then(
    (data) => {
      const txData = JSON.parse(data);
      return parseTxDetails(txData, chain, txid, utxoIndex);
    },
    (error) => {
      throw error;
    },
  );
}

const txidToTxref = (txid, chain, utxoIndex) => getTxDetails(txid, chain, utxoIndex)
  .then(
    (data) => {
      const result = txrefEncode(
        chain,
        data.blockHeight,
        data.blockIndex,
        data.utxoIndex,
      );
      return result;
    },
    (error) => {
      throw error;
    },
  );

const txrefDecode = function (bech32Tx) {
  let stripped = bech32Tx.replace(/-/g, '');
  stripped = stripped.replace(/:/g, '');

  const result = bech32.decode(stripped);
  if (result === null) {
    return null;
  }
  const buf = result.words;

  const extendedTxref = buf.length === 12;

  const chainMarker = buf[0];

  let blockHeight = 0;
  let blockIndex = 0;
  let utxoIndex = 0;

  blockHeight = buf[1] >> 1;
  blockHeight |= buf[2] << 4;
  blockHeight |= buf[3] << 9;
  blockHeight |= buf[4] << 14;
  blockHeight |= buf[5] << 19;

  // eslint-disable-next-line prefer-destructuring
  blockIndex = buf[6];
  blockIndex |= buf[7] << 5;
  blockIndex |= buf[8] << 10;

  if (extendedTxref) {
    // eslint-disable-next-line prefer-destructuring
    utxoIndex = buf[9];
    utxoIndex |= buf[10] << 5;
    utxoIndex |= buf[11] << 10;
  }

  let chain;
  if (
    chainMarker === MAGIC_BTC_MAINNET ||
    chainMarker === MAGIC_BTC_MAINNET_EXTENDED
  ) {
    chain = CHAIN_MAINNET;
  } else {
    chain = CHAIN_TESTNET;
  }

  return {
    blockHeight,
    blockIndex,
    chain,
    utxoIndex,
  };
};

const txrefToTxid = (txref) => new Promise(
  (resolve, reject) => {
    const blockLocation = txrefDecode(txref);
    if (blockLocation === null) {
      reject(new Error('Could not decode txref ' + txref));
    }

    const { blockHeight, blockIndex, chain } = blockLocation;
    let theUrl;
    if (chain === CHAIN_MAINNET) {
      theUrl = `https://api.blockcypher.com/v1/btc/main/blocks/${blockHeight}?txstart=${blockIndex}&limit=1`;
    } else {
      theUrl = `https://api.blockcypher.com/v1/btc/test3/blocks/${blockHeight}?txstart=${blockIndex}&limit=1`;
    }

    promisifiedRequests.request({ url: theUrl }).then(
      (data) => {
        const txData = JSON.parse(data);
        resolve({
          txid: txData.txids[0],
          chain,
          utxoIndex: blockLocation.utxoIndex,
        });
      },
      (error) => {
        reject(error);
      },
    );
  },
);

module.exports = {
  txidToTxref,
  txrefToTxid,
};