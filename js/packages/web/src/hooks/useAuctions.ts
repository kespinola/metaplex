import {
  ParsedAccount,
  Metadata,
  SafetyDepositBox,
  AuctionData,
  AuctionState,
  BidderMetadata,
  BidderPot,
  Vault,
  MasterEditionV1,
  MasterEditionV2,
  StringPublicKey,
  AuctionDataExtended,
  useConnection,
  getEmptyMetaState,
  loadAuction,
  MetaState
} from '@oyster/common';
import { useWallet } from '@solana/wallet-adapter-react';
import BN from 'bn.js';
import { useEffect, useState } from 'react';
import { merge } from 'lodash';
import { useMeta } from '../contexts';
import { Connection } from '@solana/web3.js';
import {
  AuctionManager,
  AuctionManagerStatus,
  AuctionManagerV1,
  AuctionManagerV2,
  BidRedemptionTicket,
  BidRedemptionTicketV2,
  getBidderKeys,
  MetaplexKey,
  SafetyDepositConfig,
  WinningConfigType,
  AuctionViewItem,
} from '@oyster/common/dist/lib/models/metaplex/index';

export enum AuctionViewState {
  Live = '0',
  Upcoming = '1',
  Ended = '2',
  BuyNow = '3',
  Defective = '-1',
}

// Flattened surface item for easy display
export interface AuctionView {
  // items 1:1 with winning configs FOR NOW
  // once tiered auctions come along, this becomes an array of arrays.
  items: AuctionViewItem[][];
  safetyDepositBoxes: ParsedAccount<SafetyDepositBox>[];
  auction: ParsedAccount<AuctionData>;
  auctionDataExtended?: ParsedAccount<AuctionDataExtended>;
  auctionManager: AuctionManager;
  participationItem?: AuctionViewItem;
  state: AuctionViewState;
  thumbnail: AuctionViewItem;
  myBidderMetadata?: ParsedAccount<BidderMetadata>;
  myBidderPot?: ParsedAccount<BidderPot>;
  myBidRedemption?: ParsedAccount<BidRedemptionTicket>;
  vault: ParsedAccount<Vault>;
  totallyComplete: boolean;
  isInstantSale: boolean;
}

export function useCachedRedemptionKeysByWallet() {
  const { auctions, bidRedemptions } = useMeta();
  const { publicKey } = useWallet();

  const [cachedRedemptionKeys, setCachedRedemptionKeys] = useState<
    Record<
      string,
      | ParsedAccount<BidRedemptionTicket>
      | { pubkey: StringPublicKey; info: null }
    >
  >({});

  useEffect(() => {
    (async () => {
      if (publicKey) {
        const temp: Record<
          string,
          | ParsedAccount<BidRedemptionTicket>
          | { pubkey: StringPublicKey; info: null }
        > = {};
        const keys = Object.keys(auctions);
        const tasks: Promise<void>[] = [];
        for (let i = 0; i < keys.length; i++) {
          const a = keys[i];
          if (!cachedRedemptionKeys[a])
            tasks.push(
              getBidderKeys(auctions[a].pubkey, publicKey.toBase58()).then(
                key => {
                  temp[a] = bidRedemptions[key.bidRedemption]
                    ? bidRedemptions[key.bidRedemption]
                    : { pubkey: key.bidRedemption, info: null };
                },
              ),
            );
          else if (!cachedRedemptionKeys[a].info) {
            temp[a] =
              bidRedemptions[cachedRedemptionKeys[a].pubkey] ||
              cachedRedemptionKeys[a];
          }
        }

        await Promise.all(tasks);

        setCachedRedemptionKeys(temp);
      }
    })();
  }, [auctions, bidRedemptions, publicKey]);

  return cachedRedemptionKeys;
}

export const useAuctions = (state?: AuctionViewState) => {
  const [auctionViews, setAuctionViews] = useState<AuctionView[]>([]);
  const { publicKey } = useWallet();
  const cachedRedemptionKeys = useCachedRedemptionKeysByWallet();

  const {
    auctions,
    auctionManagersByAuction,
    safetyDepositBoxesByVaultAndIndex,
    metadataByMint,
    bidderMetadataByAuctionAndBidder,
    bidderPotsByAuctionAndBidder,
    vaults,
    masterEditions,
    masterEditionsByPrintingMint,
    masterEditionsByOneTimeAuthMint,
    metadataByMasterEdition,
    safetyDepositConfigsByAuctionManagerAndIndex,
    bidRedemptionV2sByAuctionManagerAndWinningIndex,
    auctionDataExtended,
  } = useMeta();

  useEffect(() => {
    const map = Object.keys(auctions).reduce((agg, a) => {
      const auction = auctions[a];
      const nextAuctionView = processAccountsIntoAuctionView(
        publicKey?.toBase58(),
        auction,
        auctionDataExtended,
        auctionManagersByAuction,
        safetyDepositBoxesByVaultAndIndex,
        metadataByMint,
        bidderMetadataByAuctionAndBidder,
        bidderPotsByAuctionAndBidder,
        bidRedemptionV2sByAuctionManagerAndWinningIndex,
        masterEditions,
        vaults,
        safetyDepositConfigsByAuctionManagerAndIndex,
        masterEditionsByPrintingMint,
        masterEditionsByOneTimeAuthMint,
        metadataByMasterEdition,
        cachedRedemptionKeys,
        state,
      );
      agg[a] = nextAuctionView;
      return agg;
    }, {} as Record<string, AuctionView | undefined>);

    setAuctionViews(
      (Object.values(map).filter(v => v) as AuctionView[]).sort((a, b) => {
        return (
          b?.auction.info.endedAt
            ?.sub(a?.auction.info.endedAt || new BN(0))
            .toNumber() || 0
        );
      }),
    );
  }, [
    state,
    auctions,
    auctionDataExtended,
    auctionManagersByAuction,
    safetyDepositBoxesByVaultAndIndex,
    metadataByMint,
    bidderMetadataByAuctionAndBidder,
    bidderPotsByAuctionAndBidder,
    bidRedemptionV2sByAuctionManagerAndWinningIndex,
    vaults,
    safetyDepositConfigsByAuctionManagerAndIndex,
    masterEditions,
    masterEditionsByPrintingMint,
    masterEditionsByOneTimeAuthMint,
    metadataByMasterEdition,
    publicKey,
    cachedRedemptionKeys,
    setAuctionViews,
  ]);

  return auctionViews;
};

const fetchAuctionsState = async (connection: Connection, auctionManagers: ParsedAccount<AuctionManagerV1 | AuctionManagerV2>[]): Promise<MetaState> => {
  const tempCache = getEmptyMetaState();

  const responses = await Promise.all(
    auctionManagers.map(auctionManager => loadAuction(connection, auctionManager))
  )

  const auctionsState = responses.reduce((memo, state) =>
    merge(memo, state),
    tempCache
  );

  return auctionsState
}

export const useInfiniteAuctions = () => {
  const connection = useConnection();
  const [auctionViews, setAuctionViews] = useState<AuctionView[]>([]);
  const { publicKey } = useWallet();
  const [initLoading, setInitLoading] = useState(true)
  const [loading, setLoading] = useState(false);
  const cachedRedemptionKeys = useCachedRedemptionKeysByWallet();
  const [auctionManagersToQuery, setAuctionManagersToQuery] = useState<
    ParsedAccount<AuctionManagerV1 | AuctionManagerV2>[]
  >([]);

  const {
    isLoading,
    auctionManagersByAuction,
    auctions,
    ...metaState
  } = useMeta();

  const gatherAuctionViews = (auctionManagers: ParsedAccount<AuctionManagerV1 | AuctionManagerV2>[], metaState: MetaState) => {
    return auctionManagers.reduce((memo: AuctionView[], auctionManager) => {
      const auction = auctions[auctionManager.info.auction]
      const nextAuctionView = assembleAuctionView(
        publicKey?.toBase58(),
        auctionManager,
        auction,
        cachedRedemptionKeys,
        metaState,
      );

      if (nextAuctionView) {
        return [...memo, nextAuctionView];
      }

      return memo;
    }, []);
  }

  useEffect(() => {
    if (isLoading) {
      return
    }

    (async () => {
      const initializedAuctions = Object.values(auctions).filter(a => a.info.state > 0)

      const startedAuctions = initializedAuctions
        .filter(a => a.info.state === 1)
        .sort((a, b) => {
          if (a.info.endAuctionAt && b.info.endAuctionAt) {
            return (
              a.info.endAuctionAt.toNumber() - b.info.endAuctionAt?.toNumber()
            );
          } else {
            return -1;
          }
        });
      const endedAuctions = initializedAuctions
        .filter(a => a.info.state === 2)
        .sort((a, b) => {
          if (a.info.endAuctionAt && b.info.endAuctionAt) {
            return (
              b.info.endAuctionAt.toNumber() - a.info.endAuctionAt?.toNumber()
            );
          } else {
            return -1;
          }
        });
      const auctionDisplayOrder = [...startedAuctions, ...endedAuctions];

      const auctionManagers = auctionDisplayOrder.map(
        auction => auctionManagersByAuction[auction.pubkey],
      );

      const auctionsToLoad = auctionManagers.splice(0, 8);

      const auctionsState = await fetchAuctionsState(connection, auctionsToLoad)

      const views = gatherAuctionViews(
        auctionsToLoad,
        merge(
          {},
          metaState,
          auctionsState,
        )
      )

      setAuctionManagersToQuery(auctionManagers)
      setAuctionViews(views)
      setInitLoading(false)
    })()
  }, [isLoading]);


  const loadMoreAuctions = () => {
    const needLoading = [...auctionManagersToQuery];
    const loaded = [...auctionViews];

    setLoading(true);
    const auctionsToLoad = needLoading.splice(0, 8);

    (async () => {
      const auctionsState = await fetchAuctionsState(connection, auctionsToLoad)

      const views = gatherAuctionViews(
        auctionsToLoad,
        merge(
          {},
          metaState,
          auctionsState,
        )
      )

      setAuctionManagersToQuery(needLoading);
      setAuctionViews([...loaded, ...views]);
      setLoading(false);
    })()
  };

  return {
    loading,
    initLoading,
    auctions: auctionViews,
    loadMore: loadMoreAuctions,
    hasNextPage: auctionManagersToQuery.length > 0,
  };
};

function isInstantSale(
  auctionDataExt: ParsedAccount<AuctionDataExtended> | null,
  auction: ParsedAccount<AuctionData>,
) {
  return !!(
    auctionDataExt?.info.instantSalePrice &&
    auction.info.priceFloor.minPrice &&
    auctionDataExt?.info.instantSalePrice.eq(auction.info.priceFloor.minPrice)
  );
}

function buildListWhileNonZero<T>(hash: Record<string, T>, key: string) {
  const list: T[] = [];
  let ticket = hash[key + '-0'];
  if (ticket) {
    list.push(ticket);
    let i = 1;
    while (ticket) {
      ticket = hash[key + '-' + i.toString()];
      if (ticket) list.push(ticket);
      i++;
    }
  }
  return list;
}


export function assembleAuctionView(
  walletPubkey: StringPublicKey | null | undefined,
  parsedAuctionManager: ParsedAccount<AuctionManagerV1 | AuctionManagerV2>,
  auction: ParsedAccount<AuctionData>,
  cachedRedemptionKeys: Record<
    string,
    ParsedAccount<BidRedemptionTicket> | { pubkey: StringPublicKey; info: null }
  >,
  {
    safetyDepositBoxesByVaultAndIndex,
    metadataByMint,
    bidderMetadataByAuctionAndBidder,
    bidderPotsByAuctionAndBidder,
    bidRedemptionV2sByAuctionManagerAndWinningIndex,
    masterEditions,
    vaults,
    safetyDepositConfigsByAuctionManagerAndIndex,
    masterEditionsByPrintingMint,
    masterEditionsByOneTimeAuthMint,
    metadataByMasterEdition,
  }: MetaState,
): AuctionView | undefined {
  let state: AuctionViewState;
  if (auction.info.ended()) {
    state = AuctionViewState.Ended;
  } else if (auction.info.state === AuctionState.Started) {
    state = AuctionViewState.Live;
  } else if (auction.info.state === AuctionState.Created) {
    state = AuctionViewState.Upcoming;
  } else {
    state = AuctionViewState.Defective;
  }

  const vault = vaults[parsedAuctionManager.info.vault];
  const auctionManagerKey = parsedAuctionManager.pubkey;

  const safetyDepositConfigs: ParsedAccount<SafetyDepositConfig>[] =
    buildListWhileNonZero(
      safetyDepositConfigsByAuctionManagerAndIndex,
      auctionManagerKey,
    );

  const bidRedemptions: ParsedAccount<BidRedemptionTicketV2>[] =
    buildListWhileNonZero(
      bidRedemptionV2sByAuctionManagerAndWinningIndex,
      auctionManagerKey,
    );
  const auctionManager = new AuctionManager({
    instance: parsedAuctionManager,
    auction,
    vault,
    safetyDepositConfigs,
    bidRedemptions,
  });

  const boxesExpected = auctionManager.safetyDepositBoxesExpected.toNumber();

  const bidRedemption: ParsedAccount<BidRedemptionTicket> | undefined =
    cachedRedemptionKeys[auction.pubkey]?.info
      ? (cachedRedemptionKeys[
        auction.pubkey
      ] as ParsedAccount<BidRedemptionTicket>)
      : undefined;

  const bidderMetadata =
    bidderMetadataByAuctionAndBidder[auction.pubkey + '-' + walletPubkey];
  const bidderPot =
    bidderPotsByAuctionAndBidder[auction.pubkey + '-' + walletPubkey];

  const vaultKey = auctionManager.vault;
  const boxes: ParsedAccount<SafetyDepositBox>[] = buildListWhileNonZero(
    safetyDepositBoxesByVaultAndIndex,
    vaultKey,
  );

  if (boxes.length > 0) {
    let participationMetadata: ParsedAccount<Metadata> | undefined =
      undefined;
    let participationBox: ParsedAccount<SafetyDepositBox> | undefined =
      undefined;
    let participationMaster:
      | ParsedAccount<MasterEditionV1 | MasterEditionV2>
      | undefined = undefined;
    if (
      auctionManager.participationConfig !== null &&
      auctionManager.participationConfig !== undefined
    ) {
      participationBox =
        boxes[auctionManager.participationConfig?.safetyDepositBoxIndex];
      // Cover case of V1 master edition (where we're using one time auth mint in storage)
      // and case of v2 master edition where the edition itself is stored
      participationMetadata =
        metadataByMasterEdition[
        masterEditionsByOneTimeAuthMint[participationBox.info.tokenMint]
          ?.pubkey
        ] || metadataByMint[participationBox.info.tokenMint];
      if (participationMetadata) {
        participationMaster =
          masterEditionsByOneTimeAuthMint[participationBox.info.tokenMint] ||
          (participationMetadata.info.masterEdition &&
            masterEditions[participationMetadata.info.masterEdition]);
      }
    }

    const view: Partial<AuctionView> = {
      auction,
      auctionManager,
      state,
      vault,
      safetyDepositBoxes: boxes,
      items: auctionManager.getItemsFromSafetyDepositBoxes(
        metadataByMint,
        masterEditionsByPrintingMint,
        metadataByMasterEdition,
        masterEditions,
        boxes,
      ),
      participationItem:
        participationMetadata && participationBox
          ? {
            metadata: participationMetadata,
            safetyDeposit: participationBox,
            masterEdition: participationMaster,
            amount: new BN(1),
            winningConfigType: WinningConfigType.Participation,
          }
          : undefined,
      myBidderMetadata: bidderMetadata,
      myBidderPot: bidderPot,
      myBidRedemption: bidRedemption,
    };

    view.thumbnail =
      ((view.items || [])[0] || [])[0] || view.participationItem;

    view.totallyComplete = !!(
      view.thumbnail &&
      boxesExpected ===
      (view.items || []).length +
      (auctionManager.participationConfig === null ||
        auctionManager.participationConfig === undefined
        ? 0
        : 1) &&
      (auctionManager.participationConfig === null ||
        auctionManager.participationConfig === undefined ||
        (auctionManager.participationConfig !== null &&
          view.participationItem)) &&
      view.vault
    );

    if (!view.thumbnail || !view.thumbnail.metadata) {
      return undefined;
    }

    return view as AuctionView;
  }

  return undefined;
}

export function processAccountsIntoAuctionView(
  walletPubkey: StringPublicKey | null | undefined,
  auction: ParsedAccount<AuctionData>,
  auctionDataExtended: Record<string, ParsedAccount<AuctionDataExtended>>,
  auctionManagersByAuction: Record<
    string,
    ParsedAccount<AuctionManagerV1 | AuctionManagerV2>
  >,
  safetyDepositBoxesByVaultAndIndex: Record<
    string,
    ParsedAccount<SafetyDepositBox>
  >,
  metadataByMint: Record<string, ParsedAccount<Metadata>>,
  bidderMetadataByAuctionAndBidder: Record<
    string,
    ParsedAccount<BidderMetadata>
  >,
  bidderPotsByAuctionAndBidder: Record<string, ParsedAccount<BidderPot>>,
  bidRedemptionV2sByAuctionManagerAndWinningIndex: Record<
    string,
    ParsedAccount<BidRedemptionTicketV2>
  >,
  masterEditions: Record<
    string,
    ParsedAccount<MasterEditionV1 | MasterEditionV2>
  >,
  vaults: Record<string, ParsedAccount<Vault>>,
  safetyDepositConfigsByAuctionManagerAndIndex: Record<
    string,
    ParsedAccount<SafetyDepositConfig>
  >,
  masterEditionsByPrintingMint: Record<string, ParsedAccount<MasterEditionV1>>,
  masterEditionsByOneTimeAuthMint: Record<
    string,
    ParsedAccount<MasterEditionV1>
  >,
  metadataByMasterEdition: Record<string, ParsedAccount<Metadata>>,
  cachedRedemptionKeysByWallet: Record<
    string,
    ParsedAccount<BidRedemptionTicket> | { pubkey: StringPublicKey; info: null }
  >,
  desiredState: AuctionViewState | undefined,
  existingAuctionView?: AuctionView,
): AuctionView | undefined {
  let state: AuctionViewState;
  if (auction.info.ended()) {
    state = AuctionViewState.Ended;
  } else if (auction.info.state === AuctionState.Started) {
    state = AuctionViewState.Live;
  } else if (auction.info.state === AuctionState.Created) {
    state = AuctionViewState.Upcoming;
  } else {
    state = AuctionViewState.BuyNow;
  }

  const auctionManagerInstance = auctionManagersByAuction[auction.pubkey || ''];

  // The defective auction view state really applies to auction managers, not auctions, so we ignore it here
  if (
    desiredState &&
    desiredState !== AuctionViewState.Defective &&
    desiredState !== state
  )
    return undefined;

  if (auctionManagerInstance) {
    // instead we apply defective state to auction managers
    if (
      desiredState === AuctionViewState.Defective &&
      auctionManagerInstance.info.state.status !==
        AuctionManagerStatus.Initialized
    )
      return undefined;
    // Generally the only way an initialized auction manager can get through is if you are asking for defective ones.
    else if (
      desiredState !== AuctionViewState.Defective &&
      auctionManagerInstance.info.state.status ===
        AuctionManagerStatus.Initialized
    )
      return undefined;

    const vault = vaults[auctionManagerInstance.info.vault];
    const auctionManagerKey = auctionManagerInstance.pubkey;

    const safetyDepositConfigs: ParsedAccount<SafetyDepositConfig>[] =
      buildListWhileNonZero(
        safetyDepositConfigsByAuctionManagerAndIndex,
        auctionManagerKey,
      );

    const bidRedemptions: ParsedAccount<BidRedemptionTicketV2>[] =
      buildListWhileNonZero(
        bidRedemptionV2sByAuctionManagerAndWinningIndex,
        auctionManagerKey,
      );
    const auctionManager = new AuctionManager({
      instance: auctionManagerInstance,
      auction,
      vault,
      safetyDepositConfigs,
      bidRedemptions,
    });

    const auctionDataExtendedKey =
      auctionManagerInstance.info.key == MetaplexKey.AuctionManagerV2
        ? (auctionManagerInstance as ParsedAccount<AuctionManagerV2>).info
            .auctionDataExtended
        : null;
    const auctionDataExt = auctionDataExtendedKey
      ? auctionDataExtended[auctionDataExtendedKey]
      : null;

    const boxesExpected = auctionManager.safetyDepositBoxesExpected.toNumber();

    const bidRedemption: ParsedAccount<BidRedemptionTicket> | undefined =
      cachedRedemptionKeysByWallet[auction.pubkey]?.info
        ? (cachedRedemptionKeysByWallet[
            auction.pubkey
          ] as ParsedAccount<BidRedemptionTicket>)
        : undefined;

    const bidderMetadata =
      bidderMetadataByAuctionAndBidder[auction.pubkey + '-' + walletPubkey];
    const bidderPot =
      bidderPotsByAuctionAndBidder[auction.pubkey + '-' + walletPubkey];

    if (existingAuctionView && existingAuctionView.totallyComplete) {
      // If totally complete, we know we arent updating anythign else, let's speed things up
      // and only update the two things that could possibly change
      existingAuctionView.auction = auction;
      existingAuctionView.myBidderPot = bidderPot;
      existingAuctionView.myBidderMetadata = bidderMetadata;
      existingAuctionView.myBidRedemption = bidRedemption;
      existingAuctionView.auctionDataExtended = auctionDataExt || undefined;
      existingAuctionView.vault = vault;
      existingAuctionView.isInstantSale = isInstantSale(
        auctionDataExt,
        auction,
      );
      for (let i = 0; i < existingAuctionView.items.length; i++) {
        const winningSet = existingAuctionView.items[i];
        for (let j = 0; j < winningSet.length; j++) {
          const curr = winningSet[j];
          if (!curr.metadata) {
            let foundMetadata =
              metadataByMint[curr.safetyDeposit.info.tokenMint];
            if (!foundMetadata) {
              // Means is a limited edition, so the tokenMint is the printingMint
              const masterEdition =
                masterEditionsByPrintingMint[curr.safetyDeposit.info.tokenMint];
              if (masterEdition) {
                foundMetadata = metadataByMasterEdition[masterEdition.pubkey];
              }
            }
            curr.metadata = foundMetadata;
          }

          if (
            curr.metadata &&
            !curr.masterEdition &&
            curr.metadata.info.masterEdition
          ) {
            const foundMaster =
              masterEditions[curr.metadata.info.masterEdition];

            curr.masterEdition = foundMaster;
          }
        }
      }

      return existingAuctionView;
    }

    const vaultKey = auctionManager.vault;
    const boxes: ParsedAccount<SafetyDepositBox>[] = buildListWhileNonZero(
      safetyDepositBoxesByVaultAndIndex,
      vaultKey,
    );
    if (boxes.length > 0) {
      let participationMetadata: ParsedAccount<Metadata> | undefined =
        undefined;
      let participationBox: ParsedAccount<SafetyDepositBox> | undefined =
        undefined;
      let participationMaster:
        | ParsedAccount<MasterEditionV1 | MasterEditionV2>
        | undefined = undefined;
      if (
        auctionManager.participationConfig !== null &&
        auctionManager.participationConfig !== undefined
      ) {
        participationBox =
          boxes[auctionManager.participationConfig?.safetyDepositBoxIndex];
        // Cover case of V1 master edition (where we're using one time auth mint in storage)
        // and case of v2 master edition where the edition itself is stored
        participationMetadata =
          metadataByMasterEdition[
            masterEditionsByOneTimeAuthMint[participationBox.info.tokenMint]
              ?.pubkey
          ] || metadataByMint[participationBox.info.tokenMint];
        if (participationMetadata) {
          participationMaster =
            masterEditionsByOneTimeAuthMint[participationBox.info.tokenMint] ||
            (participationMetadata.info.masterEdition &&
              masterEditions[participationMetadata.info.masterEdition]);
        }
      }

      const view: Partial<AuctionView> = {
        auction,
        auctionManager,
        state,
        vault,
        auctionDataExtended: auctionDataExt || undefined,
        safetyDepositBoxes: boxes,
        items: auctionManager.getItemsFromSafetyDepositBoxes(
          metadataByMint,
          masterEditionsByPrintingMint,
          metadataByMasterEdition,
          masterEditions,
          boxes,
        ),
        participationItem:
          participationMetadata && participationBox
            ? {
                metadata: participationMetadata,
                safetyDeposit: participationBox,
                masterEdition: participationMaster,
                amount: new BN(1),
                winningConfigType: WinningConfigType.Participation,
              }
            : undefined,
        myBidderMetadata: bidderMetadata,
        myBidderPot: bidderPot,
        myBidRedemption: bidRedemption,
      };

      view.thumbnail =
        ((view.items || [])[0] || [])[0] || view.participationItem;

      view.isInstantSale = isInstantSale(auctionDataExt, auction);

      view.totallyComplete = !!(
        view.thumbnail &&
        boxesExpected ===
          (view.items || []).length +
            (auctionManager.participationConfig === null ||
            auctionManager.participationConfig === undefined
              ? 0
              : 1) &&
        (auctionManager.participationConfig === null ||
          auctionManager.participationConfig === undefined ||
          (auctionManager.participationConfig !== null &&
            view.participationItem)) &&
        view.vault
      );
      if (
        (!view.thumbnail || !view.thumbnail.metadata) &&
        desiredState != AuctionViewState.Defective
      )
        return undefined;

      return view as AuctionView;
    }
  }

  return undefined;
}