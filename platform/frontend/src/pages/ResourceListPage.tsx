import { useEffect, useState } from 'react';
import { Card, Empty, Input, Pagination, Select, Skeleton, Space, Tag, Tabs, Typography } from 'antd';
import { SearchOutlined, DownloadOutlined, StarFilled } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { assetUrl, listAssets } from '../api';
import type { Asset, AssetType, PageResponse } from '../types';
import { getErrorMessage } from '../utils';

const typeTabs = [{ key: 'agent', label: '智能体' }];

export default function ResourceListPage() {
  const [type, setType] = useState<AssetType>('agent');
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('createdAt');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PageResponse>({ items: [], total: 0, page: 1, limit: 12, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    listAssets(type, { search, sort, page, limit: 12 })
      .then(setResult).catch((err) => setError(getErrorMessage(err))).finally(() => setLoading(false));
  }, [type, search, sort, page]);

  const submitSearch = () => { setPage(1); setSearch(keyword.trim()); };
  const renderCard = (asset: Asset) => <Link to={`/asset/${type}/${asset.id}`} key={asset.id}>
    <Card hoverable className="asset-card" cover={<div className="asset-cover">{asset.previewUrl ? <img src={assetUrl(asset.previewUrl)} alt="" /> : <div className="cover-letter">{asset.name.slice(0, 1)}</div>}<span className="asset-type">{asset.type || '智能体'}</span></div>}>
      <div className="asset-card-title"><Typography.Title level={5} ellipsis={{ rows: 1 }}>{asset.name}</Typography.Title><Tag bordered={false} color={asset.status === 'approved' ? 'green' : 'gold'}>{asset.status === 'approved' ? '已发布' : asset.status}</Tag></div>
      <Typography.Paragraph ellipsis={{ rows: 2 }} type="secondary">{asset.description || '暂无描述'}</Typography.Paragraph>
      <div className="asset-meta"><span><StarFilled className="star" /> {asset.rating?.toFixed(1) || '0.0'}</span><span><DownloadOutlined /> {asset.downloads}</span><span>v{asset.version}</span></div>
    </Card>
  </Link>;

  return <div className="content-wrap">
    <section className="list-hero"><div><span className="eyebrow">CURATED COLLECTION</span><Typography.Title>把喜欢的东西，<br /><em>带回桌面。</em></Typography.Title><Typography.Paragraph>发现社区精选的智能体配置，让桌面助手更贴合你的日常。</Typography.Paragraph></div><div className="hero-stamp">{String(result.total).padStart(2, '0')}<small> ITEMS</small></div></section>
    <div className="toolbar"><Tabs activeKey={type} items={typeTabs} onChange={(value) => { setType(value as AssetType); setPage(1); }} /><Space wrap><Input className="search-input" allowClear value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={submitSearch} prefix={<SearchOutlined />} placeholder="搜索名称或描述" /><Select value={sort} onChange={(value) => { setSort(value); setPage(1); }} options={[{ value: 'createdAt', label: '最新发布' }, { value: 'downloads', label: '下载最多' }, { value: 'rating', label: '评分最高' }]} /></Space></div>
    {error ? <Empty description={error} /> : loading ? <div className="asset-grid">{Array.from({ length: 6 }).map((_, index) => <Card key={index}><Skeleton active /></Card>)}</div> : result.items.length ? <div className="asset-grid">{result.items.map(renderCard)}</div> : <Empty className="empty-space" description="还没有找到匹配资源" />}
    {!!result.total && <Pagination className="pagination" current={page} pageSize={result.limit} total={result.total} showSizeChanger={false} onChange={setPage} />}
  </div>;
}
