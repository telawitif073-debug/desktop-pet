import { useEffect, useState } from 'react';
import { Alert, Avatar, Button, Card, Divider, Empty, Form, Input, Rate, Spin, Tag, Typography, message } from 'antd';
import { ArrowLeftOutlined, DownloadOutlined, StarFilled, UserOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { assetUrl, downloadAsset, getAsset, listReviews, submitReview } from '../api';
import type { Asset, AssetType, Review, User } from '../types';
import { formatDate, getErrorMessage } from '../utils';

export default function ResourceDetailPage({ user }: { user: User | null }) {
  const { type: rawType, id } = useParams();
  const type = rawType as AssetType;
  const [asset, setAsset] = useState<Asset | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const navigate = useNavigate();

  useEffect(() => {
    if (!id || (type !== 'pet' && type !== 'agent')) return;
    Promise.all([getAsset(type, id), listReviews(type, id)]).then(([nextAsset, nextReviews]) => { setAsset(nextAsset); setReviews(nextReviews); }).catch(() => messageApi.error('资源加载失败')).finally(() => setLoading(false));
  }, [type, id]);

  if (loading) return <div className="loading-state"><Spin size="large" /></div>;
  if (!asset) return <Empty description="资源不存在或尚未通过审核" />;

  const download = async () => {
    setDownloading(true);
    try { const result = await downloadAsset(type, asset.id); setAsset({ ...asset, downloads: result.downloads }); window.open(assetUrl(result.url), '_blank'); }
    catch (err) { messageApi.error(getErrorMessage(err)); }
    finally { setDownloading(false); }
  };
  const review = async (values: { rating: number; comment: string }) => {
    if (!user) { navigate('/login'); return; }
    try { const next = await submitReview(type, asset.id, values.rating, values.comment); setReviews([next, ...reviews.filter((item) => item.user?.username !== user.username)]); messageApi.success('感谢你的评价'); }
    catch (err) { messageApi.error(getErrorMessage(err)); }
  };

  return <div className="content-wrap detail-wrap">
    {contextHolder}
    <Link to="/" className="back-link"><ArrowLeftOutlined /> 返回资源库</Link>
    <div className="detail-grid"><div className="detail-preview"><div className="detail-image">{asset.previewUrl ? <img src={assetUrl(asset.previewUrl)} alt={asset.name} /> : <span>{asset.name.slice(0, 1)}</span>}</div><div className="detail-file-note">资源文件：{asset.fileUrl.split('/').pop()}</div></div>
      <section className="detail-copy"><div className="detail-kicker"><Tag color="cyan">{type === 'pet' ? asset.category || '宠物资源' : asset.type || '智能体'}</Tag><span>v{asset.version}</span></div><Typography.Title>{asset.name}</Typography.Title><Typography.Paragraph className="detail-description">{asset.description || '作者还没有添加描述。'}</Typography.Paragraph><div className="detail-stats"><span><StarFilled className="star" /> {asset.rating.toFixed(1)} 评分</span><span><DownloadOutlined /> {asset.downloads} 次下载</span><span>更新于 {formatDate(asset.updatedAt)}</span></div><Button type="primary" size="large" icon={<DownloadOutlined />} loading={downloading} onClick={download}>下载资源</Button><Divider /><Typography.Title level={4}>提交评价</Typography.Title>{user ? <Form layout="vertical" onFinish={review}><Form.Item name="rating" label="评分" rules={[{ required: true, message: '请选择评分' }]}><Rate /></Form.Item><Form.Item name="comment" label="评论" rules={[{ required: true, min: 2, message: '请写下至少两字的评论' }]}><Input.TextArea rows={3} placeholder="分享你的使用感受" /></Form.Item><Button htmlType="submit">发布评价</Button></Form> : <Alert type="info" showIcon message={<span>登录后可以评价资源，<Link to="/login">去登录</Link></span>} />}</section>
    </div><Divider /><Typography.Title level={3}>用户评价 <Typography.Text type="secondary">{reviews.length}</Typography.Text></Typography.Title>{reviews.length ? <div className="review-list">{reviews.map((review) => <Card key={review.id} className="review-card" bordered={false}><div className="review-heading"><Avatar icon={<UserOutlined />} /> <div><Typography.Text strong>{review.user?.username || '用户'}</Typography.Text><Typography.Text type="secondary">{formatDate(review.createdAt)}</Typography.Text></div><Rate disabled value={review.rating || 0} /></div><Typography.Paragraph>{review.comment || '只留下了评分。'}</Typography.Paragraph></Card>)}</div> : <Empty description="还没有评价，来写第一条吧" />}</div>;
}
