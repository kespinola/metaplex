import { useWallet } from '@solana/wallet-adapter-react';
import { Col, Layout, Row, Tabs, Spin, List } from 'antd';
import BN from 'bn.js';
import React, { useMemo, useState } from 'react';
import Masonry from 'react-masonry-css';
import { Link } from 'react-router-dom';
import { AuctionRenderCard } from '../../components/AuctionRenderCard';
import { CardLoader } from '../../components/MyLoader';
import { PreSaleBanner } from '../../components/PreSaleBanner';
import { useMeta } from '../../contexts';
import useInfiniteScroll from 'react-infinite-scroll-hook';
import { LoadingOutlined } from '@ant-design/icons';
import { AuctionView, AuctionViewState, useAuctions } from '../../hooks';

const { TabPane } = Tabs;

const { Content } = Layout;

export enum LiveAuctionViewState {
  All = '0',
  Participated = '1',
  Ended = '2',
  Resale = '3',
}

export const AuctionListView = () => {
  const auctions = useAuctions();


  return (
    <List
      grid={{ gutter: 16, xs: 1, sm: 2, md: 3, lg: 4, xl: 4, xxl: 4 }}
      dataSource={auctions}
      renderItem={item => (
        <List.Item key={item.auction.pubkey}>
          <Link to={`/auction/${item.auction.pubkey}`}>
            <AuctionRenderCard auctionView={item} />
          </Link>
        </List.Item>
      )}
    />
  );
};
