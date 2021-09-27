import {
  AUCTION_ID,
  METADATA_PROGRAM_ID,
  METAPLEX_ID,
  StringPublicKey,
  toPublicKey,
  VAULT_ID,
} from '../../utils/ids';
import { MAX_WHITELISTED_CREATOR_SIZE, AuctionManagerV1, AuctionManagerV2 } from '../../models';
import {
  getEdition,
  Metadata,
  MAX_CREATOR_LEN,
  MAX_CREATOR_LIMIT,
  MAX_NAME_LENGTH,
  MAX_SYMBOL_LENGTH,
  MAX_URI_LENGTH,
  METADATA_PREFIX,
  decodeMetadata,
  getAuctionExtended,
} from '../../actions';
import { WhitelistedCreator } from '../../models/metaplex';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  AccountAndPubkey,
  MetaState,
  ProcessAccountsFunc,
  UpdateStateValueFunc,
  UnPromise,
} from './types';
import { isMetadataPartOfStore } from './isMetadataPartOfStore';
import { processAuctions } from './processAuctions';
import { processMetaplexAccounts } from './processMetaplexAccounts';
import { processMetaData } from './processMetaData';
import { processVaultData } from './processVaultData';
import { ParsedAccount } from '../accounts/types';
import { getEmptyMetaState } from './getEmptyMetaState';
import { getMultipleAccounts } from '../accounts/getMultipleAccounts';
import { getProgramAccounts } from './web3';
import { createPipelineExecutor } from './createPipelineExecutor';

export const USE_SPEED_RUN = false;
const WHITELISTED_METADATA = ['98vYFjBYS9TguUMWQRPjy2SZuxKuUMcqR4vnQiLjZbte'];
const WHITELISTED_AUCTION = ['D8wMB5iLZnsV7XQjpwqXaDynUtFuDs7cRXvEGNj1NF1e'];
const AUCTION_TO_METADATA: Record<string, string[]> = {
  D8wMB5iLZnsV7XQjpwqXaDynUtFuDs7cRXvEGNj1NF1e: [
    '98vYFjBYS9TguUMWQRPjy2SZuxKuUMcqR4vnQiLjZbte',
  ],
};
const AUCTION_TO_VAULT: Record<string, string> = {
  D8wMB5iLZnsV7XQjpwqXaDynUtFuDs7cRXvEGNj1NF1e:
    '3wHCBd3fYRPWjd5GqzrXanLJUKRyU3nECKbTPKfVwcFX',
};
const WHITELISTED_AUCTION_MANAGER = [
  '3HD2C8oCL8dpqbXo8hq3CMw6tRSZDZJGajLxnrZ3ZkYx',
];
const WHITELISTED_VAULT = ['3wHCBd3fYRPWjd5GqzrXanLJUKRyU3nECKbTPKfVwcFX'];

type StateUpdaterFunc = (state: keyof MetaState, key: string, value: ParsedAccount<any>) => MetaState

export const limitedLoadAccounts = async (
  ownerAddress: StringPublicKey,
  storeAddress: string,
  connection: Connection,
) => {
  const tempCache: MetaState = getEmptyMetaState();
  const updateTemp = makeSetter(tempCache);

  const forEach = forEachUsingUpdater(updateTemp);

  const getMetaDataByStoreOwner = async (
    ownerAddress: StringPublicKey,
  ): Promise<void> => {
    const response = await getProgramAccounts(connection, METADATA_PROGRAM_ID, {
      filters: [
        {
          memcmp: {
            offset:
              1 + // key
              32 + // update auth
              32 + // mint
              4 + // name string length
              MAX_NAME_LENGTH + // name
              4 + // uri string length
              MAX_URI_LENGTH + // uri
              4 + // symbol string length
              MAX_SYMBOL_LENGTH + // symbol
              2 + // seller fee basis points
              1 + // whether or not there is a creators vec
              4, // creators vec length
            bytes: ownerAddress,
          },
        },
      ],
    })

    await forEach(processMetaData)(response);
  };

  const getStoreAuctionManagers = async (ownerAddress: StringPublicKey) => {
    const response = await getProgramAccounts(connection, METAPLEX_ID, {
      filters: [
        {
          memcmp: {
            offset:
              1 + // key
              32, // store
            bytes: ownerAddress,
          },
        },
      ],
    });

    await forEach(processMetaplexAccounts)(response);
  };

  const getEditionsFromMetadata = async (mintIds: string[]) => {
    const editionKeys = await Promise.all(mintIds.map(getEdition));

    const editionData = await getMultipleAccounts(
      connection,
      editionKeys,
      'single',
    );

    if (editionData) {
      await Promise.all(
        editionData.keys.map((pubkey, i) => {
          processMetaData(
            {
              pubkey,
              account: editionData.array[i],
            },
            updateTemp,
          );
        }),
      );
    }
  };

  const getAuctionsFromAuctionManagers = async (
    parsedAccounts: ParsedAccount<AuctionManagerV1 | AuctionManagerV2>[],
  ) => {
    const auctionIds = parsedAccounts.map(({ info: { auction } }) => auction);

    const auctionExtendedKeys = await Promise.all(
      parsedAccounts.map(account =>
        getAuctionExtended({
          auctionProgramId: AUCTION_ID,
          resource: account.info.vault,
        }),
      ),
    );

    const auctionData = await getMultipleAccounts(
      connection,
      [...auctionIds, ...auctionExtendedKeys],
      'single',
    );

    if (auctionData) {
      await Promise.all(
        auctionData.keys.map((pubkey, i) => {
          processAuctions(
            {
              pubkey,
              account: auctionData.array[i],
            },
            updateTemp,
          );
        }),
      );
    }
  };

  const getVaultsForAuctionManagers = async (
    parsedAccounts: ParsedAccount<AuctionManagerV1 | AuctionManagerV2>[],
  ) => {
    const vaultKeys = parsedAccounts.map(({ info: { vault } }) => vault);

    const vaultData = await getMultipleAccounts(
      connection,
      vaultKeys,
      'single',
    );

    if (vaultData) {
      await Promise.all(
        vaultData.keys.map((pubkey, i) => {
          processVaultData(
            {
              pubkey,
              account: vaultData.array[i],
            },
            updateTemp,
          );
        }),
      );
    }
  };

  const getStore = async (storeAddress: string) => {
    const storePubkey = new PublicKey(storeAddress);
    const storeData = await connection.getAccountInfo(storePubkey);

    if (storeData) {
      //@ts-ignore
      storeData.owner = storeData.owner.toBase58();
      processMetaplexAccounts(
        {
          pubkey: storeAddress,
          account: storeData,
        },
        updateTemp,
      );
    }
  };

  await Promise.all([
    getStoreAuctionManagers(ownerAddress),
    getStore(storeAddress),
    getMetaDataByStoreOwner(ownerAddress),
  ]);

  const parsedAuctionManagers = Object.values(
    tempCache.auctionManagersByAuction,
  );

  const mintIds = Object.keys(tempCache.metadataByMint);

  const promises = [
    getAuctionsFromAuctionManagers(parsedAuctionManagers),
    getVaultsForAuctionManagers(parsedAuctionManagers),
    getEditionsFromMetadata(mintIds),
    // // prize tracking tickets
    // ...Object.keys(AUCTION_TO_METADATA)
    //   .map(key =>
    //     AUCTION_TO_METADATA[key]
    //       .map(md =>
    //         getProgramAccounts(connection, METAPLEX_ID, {
    //           filters: [
    //             {
    //               memcmp: {
    //                 offset: 1,
    //                 bytes: md,
    //               },
    //             },
    //           ],
    //         }).then(forEach(processMetaplexAccounts)),
    //       )
    //       .flat(),
    //   )
    //   .flat(),
    // whitelisted creators
    getProgramAccounts(connection, METAPLEX_ID, {
      filters: [
        {
          dataSize: MAX_WHITELISTED_CREATOR_SIZE,
        },
      ],
    }).then(forEach(processMetaplexAccounts)),
  ];

  await Promise.all(promises);

  await postProcessMetadata(tempCache);

  return tempCache;
};

const forEachUsingUpdater =
  (updateTemp: StateUpdaterFunc) => (fn: ProcessAccountsFunc) => async (accounts: AccountAndPubkey[]) => {
    for (const account of accounts) {
      await fn(account, updateTemp);
    }
  };

export const loadAuction = async (
  connection: Connection,
  auctionManager: ParsedAccount<AuctionManagerV1 | AuctionManagerV2>,
  complete: boolean = false,
): Promise<MetaState> => {
  const tempCache: MetaState = getEmptyMetaState();
  const updateTemp = makeSetter(tempCache);

  const forEach = forEachUsingUpdater(updateTemp)

  const rpcQueries = [
    // safety deposit box config
    getProgramAccounts(connection, METAPLEX_ID, {
      filters: [
        {
          memcmp: {
            offset: 1,
            bytes: auctionManager.pubkey,
          },
        },
      ],
    }).then(forEach(processMetaplexAccounts)),
    // safety deposit
    getProgramAccounts(connection, VAULT_ID, {
      filters: [
        {
          memcmp: {
            offset: 1,
            bytes: auctionManager.info.vault,
          },
        },
      ],
    }).then(forEach(processVaultData)),
  ]

  if (complete) {
    rpcQueries.push(
      // bidder redemptions
      getProgramAccounts(connection, METAPLEX_ID, {
        filters: [
          {
            memcmp: {
              offset: 9,
              bytes: auctionManager.pubkey,
            },
          },
        ],
      }).then(forEach(processMetaplexAccounts)),
      // bidder metadata
      getProgramAccounts(connection, AUCTION_ID, {
        filters: [
          {
            memcmp: {
              offset: 32,
              bytes: auctionManager.info.auction,
            },
          },
        ],
      }).then(forEach(processAuctions)),
      // bidder pot
      getProgramAccounts(connection, AUCTION_ID, {
        filters: [
          {
            memcmp: {
              offset: 64,
              bytes: auctionManager.info.auction,
            },
          },
        ],
      }).then(forEach(processAuctions)),
    )
  }

  await Promise.all(rpcQueries);

  return tempCache;
};

export const loadBidPotForAuctionManager = (connection: Connection, auctionManager: ParsedAccount<AuctionManagerV1 | AuctionManagerV2>) => {

}

export const loadAccounts = async (connection: Connection) => {
  const state: MetaState = getEmptyMetaState();
  const updateState = makeSetter(state);
  const forEachAccount = processingAccounts(updateState);

  const loadVaults = () =>
    getProgramAccounts(connection, VAULT_ID).then(
      forEachAccount(processVaultData),
    );
  const loadAuctions = () =>
    getProgramAccounts(connection, AUCTION_ID).then(
      forEachAccount(processAuctions),
    );
  const loadMetaplex = () =>
    getProgramAccounts(connection, METAPLEX_ID).then(
      forEachAccount(processMetaplexAccounts),
    );
  const loadCreators = () =>
    getProgramAccounts(connection, METAPLEX_ID, {
      filters: [
        {
          dataSize: MAX_WHITELISTED_CREATOR_SIZE,
        },
      ],
    }).then(forEachAccount(processMetaplexAccounts));
  const loadMetadata = () =>
    pullMetadataByCreators(connection, state, updateState);
  const loadEditions = () => pullEditions(connection, updateState, state);

  const loading = [
    loadCreators().then(loadMetadata).then(loadEditions),
    loadVaults(),
    loadAuctions(),
    loadMetaplex(),
  ];

  await Promise.all(loading);

  console.log('Metadata size', state.metadata.length);

  return state;
};

const pullEditions = async (
  connection: Connection,
  updater: UpdateStateValueFunc,
  state: MetaState,
) => {
  console.log('Pulling editions for optimized metadata');

  type MultipleAccounts = UnPromise<ReturnType<typeof getMultipleAccounts>>;
  let setOf100MetadataEditionKeys: string[] = [];
  const editionPromises: Promise<void>[] = [];

  const loadBatch = () => {
    editionPromises.push(
      getMultipleAccounts(
        connection,
        setOf100MetadataEditionKeys,
        'recent',
      ).then(processEditions),
    );
    setOf100MetadataEditionKeys = [];
  };

  const processEditions = (returnedAccounts: MultipleAccounts) => {
    for (let j = 0; j < returnedAccounts.array.length; j++) {
      processMetaData(
        {
          pubkey: returnedAccounts.keys[j],
          account: returnedAccounts.array[j],
        },
        updater,
      );
    }
  };

  for (const metadata of state.metadata) {
    let editionKey: StringPublicKey;
    if (metadata.info.editionNonce === null) {
      editionKey = await getEdition(metadata.info.mint);
    } else {
      editionKey = (
        await PublicKey.createProgramAddress(
          [
            Buffer.from(METADATA_PREFIX),
            toPublicKey(METADATA_PROGRAM_ID).toBuffer(),
            toPublicKey(metadata.info.mint).toBuffer(),
            new Uint8Array([metadata.info.editionNonce || 0]),
          ],
          toPublicKey(METADATA_PROGRAM_ID),
        )
      ).toBase58();
    }

    setOf100MetadataEditionKeys.push(editionKey);

    if (setOf100MetadataEditionKeys.length >= 100) {
      loadBatch();
    }
  }

  if (setOf100MetadataEditionKeys.length >= 0) {
    loadBatch();
  }

  await Promise.all(editionPromises);

  console.log(
    'Edition size',
    Object.keys(state.editions).length,
    Object.keys(state.masterEditions).length,
  );
};

const pullMetadataByCreators = (
  connection: Connection,
  state: MetaState,
  updater: UpdateStateValueFunc,
): Promise<any> => {
  console.log('pulling optimized nfts');

  const whitelistedCreators = Object.values(state.whitelistedCreatorsByCreator);

  const setter: UpdateStateValueFunc = async (prop, key, value) => {
    if (prop === 'metadataByMint') {
      await initMetadata(value, state.whitelistedCreatorsByCreator, updater);
    } else {
      updater(prop, key, value);
    }
  };
  const forEachAccount = processingAccounts(setter);

  const additionalPromises: Promise<void>[] = [];
  for (const creator of whitelistedCreators) {
    for (let i = 0; i < MAX_CREATOR_LIMIT; i++) {
      const promise = getProgramAccounts(connection, METADATA_PROGRAM_ID, {
        filters: [
          {
            memcmp: {
              offset:
                1 + // key
                32 + // update auth
                32 + // mint
                4 + // name string length
                MAX_NAME_LENGTH + // name
                4 + // uri string length
                MAX_URI_LENGTH + // uri
                4 + // symbol string length
                MAX_SYMBOL_LENGTH + // symbol
                2 + // seller fee basis points
                1 + // whether or not there is a creators vec
                4 + // creators vec length
                i * MAX_CREATOR_LEN,
              bytes: creator.info.address,
            },
          },
        ],
      }).then(forEachAccount(processMetaData));
      additionalPromises.push(promise);
    }
  }

  return Promise.all(additionalPromises);
};

export const makeSetter =
  (state: MetaState): UpdateStateValueFunc<MetaState> =>
  (prop, key, value) => {
    if (prop === 'store') {
      state[prop] = value;
    } else if (prop === 'metadata') {
      state.metadata.push(value);
    } else {
      state[prop][key] = value;
    }
    return state;
  };

export const processingAccounts =
  (updater: UpdateStateValueFunc) =>
  (fn: ProcessAccountsFunc) =>
  async (accounts: AccountAndPubkey[]) => {
    await createPipelineExecutor(
      accounts.values(),
      account => fn(account, updater),
      {
        sequence: 10,
        delay: 1,
        jobsCount: 3,
      },
    );
  };

const postProcessMetadata = async (state: MetaState) => {
  const values = Object.values(state.metadataByMint);

  for (const metadata of values) {
    await metadataByMintUpdater(metadata, state);
  }
};

export const metadataByMintUpdater = async (
  metadata: ParsedAccount<Metadata>,
  state: MetaState,
) => {
  const key = metadata.info.mint;
  if (isMetadataPartOfStore(metadata, state.whitelistedCreatorsByCreator)) {
    await metadata.info.init();
    const masterEditionKey = metadata.info?.masterEdition;
    if (masterEditionKey) {
      state.metadataByMasterEdition[masterEditionKey] = metadata;
    }
    state.metadataByMint[key] = metadata;
    state.metadata.push(metadata);
  } else {
    delete state.metadataByMint[key];
  }
  return state;
};

export const initMetadata = async (
  metadata: ParsedAccount<Metadata>,
  whitelistedCreators: Record<string, ParsedAccount<WhitelistedCreator>>,
  setter: UpdateStateValueFunc,
) => {
  if (isMetadataPartOfStore(metadata, whitelistedCreators)) {
    await metadata.info.init();
    setter('metadataByMint', metadata.info.mint, metadata);
    setter('metadata', '', metadata);
    const masterEditionKey = metadata.info?.masterEdition;
    if (masterEditionKey) {
      setter('metadataByMasterEdition', masterEditionKey, metadata);
    }
  }
};