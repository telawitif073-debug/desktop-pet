import { useEffect, useState } from 'react';
import { Alert, Avatar, Button, Card, Divider, Empty, Form, Input, Rate, Space, Spin, Tag, Typography, message } from 'antd';
import { ArrowLeftOutlined, DownloadOutlined, StarFilled, UserOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { assetUrl, downloadAsset, getAsset, listReviews, submitReview } from '../api';
import type { Asset, AssetType, Review, User } from '../types';
import { formatDate, getErrorMessage } from '../utils';

/** 宠物本体类型 → 展示文案 */
const bodyKindLabels: Record<string, string> = { 'body-model': '模型', 'body-animation': '动画', 'body-still': '静图' };

/** manifest 快照里的一行资源（本体 / 被拒资源） */
interface ManifestLine { path?: string; role?: string; evidence?: string[] }
const manifestLines = (value: unknown): ManifestLine[] => (Array.isArray(value) ? (value as ManifestLine[]) : []);

/** 包体积格式化：>=1MB 显示 MB，否则 KB */
const formatBytes = (bytes?: number | null) => {
  if (bytes === undefined || bytes === null) return '未知';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
};

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
    try {
      if (window.electronAPI?.platform) {
        // 桌面宠物客户端内：调用主进程下载并安装到本地（宠物附带动作同步安装）
        await window.electronAPI.platform.install(type, asset.id);
        messageApi.success(type === 'pet' ? '已下载并安装为桌面宠物形象（附带动作同步安装）' : '智能体已安装到桌面宠物');
      } else {
        // 浏览器环境：触发真实文件下载，而不是打开预览
        const result = await downloadAsset(type, asset.id);
        setAsset({ ...asset, downloads: result.downloads });
        const fileUrl = assetUrl(result.url);
        if (!fileUrl) throw new Error('资源文件地址为空');
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error('资源文件下载失败');
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = (result.url || asset.packUrl || asset.fileUrl || asset.name).split('/').pop() || asset.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(blobUrl);
      }
    }
    catch (err) { messageApi.error(getErrorMessage(err)); }
    finally { setDownloading(false); }
  };
  const review = async (values: { rating: number; comment: string }) => {
    if (!user) { navigate('/login'); return; }
    try { const next = await submitReview(type, asset.id, values.rating, values.comment); setReviews([next, ...reviews.filter((item) => item.user?.username !== user.username)]); messageApi.success('感谢你的评价'); }
    catch (err) { messageApi.error(getErrorMessage(err)); }
  };

  // 宠物包：从服务端校验快照中提取自动判定摘要
  const bodyLines = manifestLines(asset.manifest?.body);
  const rejectedLines = manifestLines(asset.manifest?.rejected);
  const packFileName = (asset.packUrl || asset.fileUrl || '').split('/').pop() || '—';

  return <div className="content-wrap detail-wrap">
    {contextHolder}
    <Link to="/" className="back-link"><ArrowLeftOutlined /> 返回资源库</Link>
    <div className="detail-grid"><div className="detail-preview"><div className="detail-image">{asset.previewUrl ? <img src={assetUrl(asset.previewUrl)} alt={asset.name} /> : <span>{asset.name.slice(0, 1)}</span>}</div><div className="detail-file-note">{type === 'pet' ? '宠物包' : '资源文件'}：{packFileName}</div></div>
      <section className="detail-copy"><div className="detail-kicker"><Tag color="cyan">{type === 'pet' ? asset.category || '宠物资源' : asset.type || '智能体'}</Tag><span>v{asset.version}</span></div><Typography.Title>{asset.name}</Typography.Title><Typography.Paragraph className="detail-description">{asset.description || '作者还没有添加描述。'}</Typography.Paragraph><div className="detail-stats"><span><StarFilled className="star" /> {asset.rating.toFixed(1)} 评分</span><span><DownloadOutlined /> {asset.downloads} 次下载</span><span>更新于 {formatDate(asset.updatedAt)}</span></div><Button type="primary" size="large" icon={<DownloadOutlined />} loading={downloading} onClick={download}>下载资源</Button><Divider /><Typography.Title level={4}>提交评价</Typography.Title>{user ? <Form layout="vertical" onFinish={review}><Form.Item name="rating" label="评分" rules={[{ required: true, message: '请选择评分' }]}><Rate /></Form.Item><Form.Item name="comment" label="评论" rules={[{ required: true, min: 2, message: '请写下至少两字的评论' }]}><Input.TextArea rows={3} placeholder="分享你的使用感受" /></Form.Item><Button htmlType="submit">发布评价</Button></Form> : <Alert type="info" showIcon message={<span>登录后可以评价资源，<Link to="/login">去登录</Link></span>} />}</section>
    </div>{type === 'pet' && <><Divider /><Typography.Title level={4}>宠物包信息 <Typography.Text type="secondary">（服务端上传自动校验结果）</Typography.Text></Typography.Title><Space wrap size={8} style={{ marginBottom: 12 }}><Tag color="cyan">本体类型：{(asset.bodyKinds || []).map((kind) => bodyKindLabels[kind] || kind).join('、') || '—'}</Tag><Tag>包体积：{formatBytes(asset.packBytes)}</Tag><Tag>版本：v{asset.version}</Tag><Tag>sha256：{asset.packSha256 ? asset.packSha256.slice(0, 8) : '—'}</Tag></Space><Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>本体条目 {bodyLines.length} 条 · 被拒资源 {rejectedLines.length} 条</Typography.Paragraph>{rejectedLines.slice(0, 5).map((line, index) => <Typography.Text key={`${line.path || index}-${index}`} type="secondary" style={{ display: 'block' }}>{line.path}（{line.role || '未知'}：{(line.evidence || []).join('；') || '无理由'}）</Typography.Text>)}</>}{type === 'pet' && asset.actions && asset.actions.length > 0 && <><Divider /><Typography.Title level={4}>附带动作 <Typography.Text type="secondary">（随宠物安装，不可跨宠物使用）</Typography.Text></Typography.Title>{asset.actions.map((action) => <Card key={action.id} size="small" style={{ marginBottom: 8 }}><Space wrap><Typography.Text strong>{action.name}</Typography.Text><Tag>{action.kind === 'clip' ? `模型动画：${action.clipName}` : '帧动画'}</Tag>{action.interaction && action.interaction !== 'none' && <Tag color="blue">{action.interaction === 'feed' ? '绑定喂食' : action.interaction === 'rest' ? '绑定休息' : '绑定玩耍'}</Tag>}</Space></Card>)}</>}<Divider /><Typography.Title level={3}>用户评价 <Typography.Text type="secondary">{reviews.length}</Typography.Text></Typography.Title>{reviews.length ? <div className="review-list">{reviews.map((review) => <Card key={review.id} className="review-card" variant="borderless"><div className="review-heading"><Avatar icon={<UserOutlined />} /> <div><Typography.Text strong>{review.user?.username || '用户'}</Typography.Text><Typography.Text type="secondary">{formatDate(review.createdAt)}</Typography.Text></div><Rate disabled value={review.rating || 0} /></div><Typography.Paragraph>{review.comment || '只留下了评分。'}</Typography.Paragraph></Card>)}</div> : <Empty description="还没有评价，来写第一条吧" />}</div>;
}
