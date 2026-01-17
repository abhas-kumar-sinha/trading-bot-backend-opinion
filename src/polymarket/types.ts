interface Market {
    id: string;
    question: string;
    conditionId: string;
    slug: string;
    resolutionSource: string;
    endDate: string;
    liquidity: string;
    startDate: string;
    image: string;
    icon: string;
    description: string;
    active: boolean;
    closed: boolean;
    archived: boolean;
    new: boolean;
    featured: boolean;
    restricted: boolean;
    volume: string;
    openInterest: number;
    createdAt: string;
    updatedAt: string;
    competitive: number;
    volume24hr: number;
    volume1wk: number;
    volume1mo: number;
    volume1yr: number;
    enableOrderBook: boolean;
    liquidityClob: number;
    negRisk: boolean;
    commentCount: number;
    cyom: boolean;
    showAllOutcomes: boolean;
    showMarketImages: boolean;
    enableNegRisk: boolean;
    automaticallyActive: boolean;
    seriesSlug: string;
    negRiskAugmented: boolean;
    pendingDeployment: boolean;
    deploying: boolean;
    deployingTimestamp: string;
    rfqEnabled: boolean;
    eventStartTime: string;
    holdingRewardsEnabled: boolean;
    feesEnabled: boolean;
    requiresTranslation: boolean;
    clobTokenIds: string[];
}

interface OrderBookEntry {
    price: string;
    size: string;
}

interface BookMessage {
    market: string;
    asset_id: string;
    bids: OrderBookEntry[];
    asks: OrderBookEntry[];
    hash: string;
    timestamp: string;
    event_type: 'book';
}


export { Market, OrderBookEntry, BookMessage };