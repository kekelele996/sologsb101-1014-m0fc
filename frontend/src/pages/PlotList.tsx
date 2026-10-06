/**
 * /plots 修复地块台账
 * 新建地块、按潮位带与底质筛选、查看栽植总株数与最新成活率、级联删除。
 * v3：验收合格后可「移交养护队」——移交时抄栽植/成活/缺株基线两侧留底；
 * 已移交地块的项目部成活率冻结，移交后的管护在养护管护台对账。
 * 消费模型：Plot、Planting、Survey、HandoverBaseline；复用组件：<RateTag>、<FilterBar>、<StatBadge>、<EmptyPanel>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  EnvironmentOutlined,
  ExperimentOutlined,
  LockOutlined,
  PlusOutlined,
  RiseOutlined,
  FallOutlined,
  SafetyCertificateOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate } from 'react-router-dom';
import FilterBar from '../components/common/FilterBar';
import EmptyPanel from '../components/common/EmptyPanel';
import RateTag from '../components/common/RateTag';
import StatBadge from '../components/common/StatBadge';
import { usePlotStore } from '../stores/plotStore';
import {
  PLOT_STATE_OPTIONS,
  RESTORE_MODE_OPTIONS,
  SUBSTRATE_OPTIONS,
  TIDE_ZONE_OPTIONS,
  type Plot,
  type PlotDraft,
  type PlotState,
} from '../types/plot';
import { ROUTES } from '../router';
import { percentText } from '../utils/rate';

const DEFAULT_DRAFT: PlotDraft = {
  name: '',
  areaMu: 30,
  tideZone: '中',
  substrate: '淤泥质',
  restoreMode: '造林',
  state: '跟踪中',
};

interface HandoverFormValues {
  handoverDate: Dayjs;
  note: string;
}

export default function PlotList() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plots = usePlotStore((state) => state.plots);
  const filters = usePlotStore((state) => state.filters);
  const setFilters = usePlotStore((state) => state.setFilters);
  const resetFilters = usePlotStore((state) => state.resetFilters);
  const visiblePlots = usePlotStore((state) => state.visiblePlots);
  const statOf = usePlotStore((state) => state.statOf);
  const summaryOf = usePlotStore((state) => state.summaryOf);
  const createPlot = usePlotStore((state) => state.createPlot);
  const updatePlot = usePlotStore((state) => state.updatePlot);
  const deletePlot = usePlotStore((state) => state.deletePlot);
  const selectPlot = usePlotStore((state) => state.selectPlot);
  const handoverPlot = usePlotStore((state) => state.handoverPlot);
  const backfillCare = usePlotStore((state) => state.backfillCare);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Plot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [handoverTarget, setHandoverTarget] = useState<Plot | null>(null);
  const [handoverSubmitting, setHandoverSubmitting] = useState(false);
  const [form] = Form.useForm<PlotDraft>();
  const [handoverForm] = Form.useForm<HandoverFormValues>();

  const rows = useMemo(() => visiblePlots(), [visiblePlots, plots, filters]);

  const totals = useMemo(() => {
    const plantTotal = plots.reduce((acc, plot) => acc + statOf(plot.id).plantTotal, 0);
    const rated = plots.filter((plot) => statOf(plot.id).surveyCount > 0);
    const avgRate =
      rated.length === 0
        ? 0
        : Math.round((rated.reduce((acc, plot) => acc + statOf(plot.id).latestRate, 0) / rated.length) * 10) / 10;
    const warnCount = plots.filter((plot) => statOf(plot.id).surveyCount > 0 && statOf(plot.id).latestRate < 70).length;
    const handedCount = plots.filter((plot) => plot.state === '已移交').length;
    const blockedCount = plots.filter((plot) => statOf(plot.id).careBlocked).length;
    return { plantTotal, avgRate, warnCount, handedCount, blockedCount };
  }, [plots, statOf]);

  /** 项目部侧留底已写、养护侧缺留底的地块——可只补跑本侧 */
  const careMissingPlots = useMemo(
    () => plots.filter((plot) => statOf(plot.id).careBaselineMissing),
    [plots, statOf],
  );

  const openCreate = (): void => {
    setEditing(null);
    form.setFieldsValue(DEFAULT_DRAFT);
    setOpen(true);
  };

  const openEdit = (plot: Plot): void => {
    setEditing(plot);
    form.setFieldsValue({
      name: plot.name,
      areaMu: plot.areaMu,
      tideZone: plot.tideZone,
      substrate: plot.substrate,
      restoreMode: plot.restoreMode,
      state: plot.state === '已移交' ? '已验收' : plot.state,
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      if (editing === null) {
        const row = await createPlot(values);
        message.success(`已新建地块「${row.name}」，可继续登记苗木批次`);
      } else {
        await updatePlot(editing.id, values);
        message.success('地块信息已更新');
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (plot: Plot): Promise<void> => {
    try {
      await deletePlot(plot.id);
      message.success(`已删除地块「${plot.name}」及其全部子记录`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  const openHandover = (plot: Plot): void => {
    setHandoverTarget(plot);
    handoverForm.setFieldsValue({ handoverDate: dayjs(), note: '' });
  };

  const handleHandover = async (): Promise<void> => {
    if (handoverTarget === null) return;
    try {
      const values = await handoverForm.validateFields();
      setHandoverSubmitting(true);
      const result = await handoverPlot(
        handoverTarget.id,
        values.handoverDate.format('YYYY-MM-DD'),
        values.note.trim(),
      );
      if (result.careWritten) {
        message.success('已移交养护队：栽植/成活/缺株基线两侧各留一份，项目部成活率停在移交当天');
      } else {
        message.warning(`项目部侧留底成功，养护队侧未写入：${result.reason ?? ''}。可在下方「只补跑养护侧」`, 8);
      }
      setHandoverTarget(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '移交失败');
    } finally {
      setHandoverSubmitting(false);
    }
  };

  const handleBackfill = async (plot: Plot): Promise<void> => {
    try {
      await backfillCare(plot.id);
      message.success(`已只补跑「${plot.name}」养护队侧留底，基线与项目部一致`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '补跑养护侧失败');
    }
  };

  const editingLocked = editing !== null && (editing.state === '已移交' || editing.readOnly === true);
  const handoverSummary = handoverTarget === null ? null : summaryOf(handoverTarget.id);

  const columns: ColumnsType<Plot> = [
    {
      title: '地块名',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Link
            onClick={() => {
              selectPlot(record.id);
              navigate(ROUTES.seedlings(record.id));
            }}
          >
            {record.name}
          </Typography.Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.restoreMode} · {record.substrate}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '面积（亩）',
      dataIndex: 'areaMu',
      key: 'areaMu',
      width: 96,
      align: 'right',
      sorter: (a, b) => a.areaMu - b.areaMu,
    },
    {
      title: '潮位带',
      dataIndex: 'tideZone',
      key: 'tideZone',
      width: 90,
      render: (value: string) => <Tag color="cyan">{value}</Tag>,
    },
    {
      title: '底质',
      dataIndex: 'substrate',
      key: 'substrate',
      width: 96,
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      width: 120,
      render: (_value, record) => (
        <Space direction="vertical" size={2}>
          <Tag color={record.state === '已验收' ? 'green' : record.state === '已移交' ? 'purple' : 'blue'}>
            {record.state === '已移交' ? <LockOutlined /> : null} {record.state}
          </Tag>
          {record.readOnly ? (
            <Tooltip title="旧数据升级时基线补不齐，先只读留着，补齐前不可移交或登记管护作业">
              <Tag color="red">只读留底</Tag>
            </Tooltip>
          ) : record.state === '已移交' ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              移交 {record.handoverDate}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '苗木批次',
      key: 'seedlingCount',
      width: 96,
      align: 'right',
      render: (_value, record) => `${statOf(record.id).seedlingCount} 批`,
    },
    {
      title: '栽植总株数',
      key: 'plantTotal',
      width: 112,
      align: 'right',
      sorter: (a, b) => statOf(a.id).plantTotal - statOf(b.id).plantTotal,
      render: (_value, record) => `${statOf(record.id).plantTotal.toLocaleString('zh-CN')} 株`,
    },
    {
      title: '验收测次',
      key: 'surveyCount',
      width: 96,
      align: 'right',
      render: (_value, record) => `${statOf(record.id).surveyCount} 次`,
    },
    {
      title: '最新成活率',
      key: 'latestRate',
      width: 210,
      render: (_value, record) => {
        const stat = statOf(record.id);
        return (
          <Space size={6} wrap>
            <RateTag rate={stat.surveyCount > 0 ? stat.latestRate : null} level={stat.level} />
            {stat.surveyCount > 0 && stat.trend !== 0 && !stat.handedOver ? (
              <Typography.Text type={stat.trend > 0 ? 'success' : 'danger'} style={{ fontSize: 12 }}>
                {stat.trend > 0 ? <RiseOutlined /> : <FallOutlined />} {Math.abs(stat.trend)}
              </Typography.Text>
            ) : null}
            {stat.handedOver ? (
              <Tooltip title="项目部那份成活率停在移交当天那版；移交后的复查由养护队单独记">
                <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                  移交冻结
                </Tag>
              </Tooltip>
            ) : null}
            {stat.careBlocked ? <Tag color="orange">养护挂起中</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '缺株数',
      dataIndex: 'missingCount',
      key: 'missingCount',
      width: 110,
      align: 'right',
      render: (value: number, record) => (
        <Typography.Text type={value > 0 && record.state !== '已移交' ? 'warning' : 'secondary'}>
          {value} 株{record.state === '已移交' ? '（基线）' : ''}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 320,
      fixed: 'right',
      render: (_value, record) => {
        const handed = record.state === '已移交';
        const readOnly = record.readOnly === true;
        const stat = statOf(record.id);
        return (
          <Space size={4} wrap>
            <Button
              size="small"
              type="link"
              onClick={() => {
                selectPlot(record.id);
                navigate(ROUTES.seedlings(record.id));
              }}
            >
              苗木批次
            </Button>
            <Button
              size="small"
              type="link"
              onClick={() => {
                selectPlot(record.id);
                navigate(ROUTES.plantings(record.id));
              }}
            >
              栽植记录
            </Button>
            {record.state === '已验收' && !readOnly ? (
              <Button
                size="small"
                type="link"
                style={{ color: '#7c3aed' }}
                icon={<SafetyCertificateOutlined />}
                onClick={() => openHandover(record)}
              >
                移交养护
              </Button>
            ) : null}
            {stat.careBaselineMissing ? (
              <Button size="small" type="link" style={{ color: '#d08700' }} onClick={() => void handleBackfill(record)}>
                只补跑养护侧
              </Button>
            ) : null}
            <Tooltip title={handed ? '已移交，项目部侧档案冻结' : readOnly ? '只读留底，暂不可编辑' : ''}>
              <Button
                size="small"
                type="link"
                icon={<EditOutlined />}
                disabled={handed || readOnly}
                onClick={() => openEdit(record)}
              >
                编辑
              </Button>
            </Tooltip>
            <Popconfirm
              title="确认删除该地块？"
              description="该地块下的苗木批次、栽植记录、验收记录与补植计划会一并删除，且不可恢复。"
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              disabled={handed || readOnly}
              onConfirm={() => void handleDelete(record)}
            >
              <Button size="small" type="link" danger icon={<DeleteOutlined />} disabled={handed || readOnly}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="地块总数" value={plots.length} suffix="块" tone="primary" icon={<EnvironmentOutlined />} />
        <StatBadge
          label="栽植总株数"
          value={totals.plantTotal.toLocaleString('zh-CN')}
          suffix="株"
          tone="info"
          icon={<ExperimentOutlined />}
        />
        <StatBadge
          label="平均成活率"
          value={percentText(totals.avgRate)}
          percent={totals.avgRate}
          tone="success"
        />
        <StatBadge
          label="已移交养护"
          value={totals.handedCount}
          suffix="块"
          tone="primary"
          icon={<SwapOutlined />}
          hint="已按移交切开：项目部数据冻结，养护队按基线对账"
        />
        <StatBadge
          label="养护挂起地块"
          value={totals.blockedCount}
          suffix="块"
          tone={totals.blockedCount > 0 ? 'danger' : 'default'}
          hint="有补苗/复查挂起复核的地块数，挂起期间不出补植计划"
        />
        <StatBadge label="筛选结果" value={rows.length} suffix="块" tone="default" size="small" />
      </div>

      {careMissingPlots.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${careMissingPlots.length} 个地块的养护队侧基线留底缺失`}
          description={
            <Space direction="vertical" size={6}>
              <span>项目部侧留底已成功，养护队那侧没写进去；两边基线必须一致，可只补跑养护队本侧。</span>
              <Space wrap>
                {careMissingPlots.map((plot) => (
                  <Button key={plot.id} size="small" onClick={() => void handleBackfill(plot)}>
                    只补跑「{plot.name}」养护侧
                  </Button>
                ))}
              </Space>
            </Space>
          }
        />
      ) : null}

      <Card
        title="修复地块台账"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建地块
          </Button>
        }
        styles={{ body: { paddingTop: 12 } }}
      >
        <FilterBar
          keyword={filters.keyword}
          onKeywordChange={(value: string) => setFilters({ keyword: value })}
          fields={[
            { key: 'tideZone', label: '潮位带', options: [...TIDE_ZONE_OPTIONS] },
            { key: 'substrate', label: '底质', options: [...SUBSTRATE_OPTIONS] },
          ]}
          values={{ tideZone: filters.tideZone, substrate: filters.substrate }}
          onChange={(key: string, value: string) => {
            if (key === 'tideZone') setFilters({ tideZone: value as PlotDraft['tideZone'] | 'all' });
            if (key === 'substrate') setFilters({ substrate: value as PlotDraft['substrate'] | 'all' });
          }}
          onReset={resetFilters}
          resultText={`命中 ${rows.length} / ${plots.length} 块`}
        />

        {ready && plots.length === 0 ? (
          <EmptyPanel
            title="还没有修复地块"
            description="先建立修复地块，再登记苗木批次与栽植记录，验收合格后移交给养护队并抄出基线。"
            actionText="新建第一个地块"
            onAction={openCreate}
          />
        ) : (
          <Table<Plot>
            rowKey="id"
            size="middle"
            loading={!ready}
            columns={columns}
            dataSource={rows}
            scroll={{ x: 1680 }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: (
                <EmptyPanel
                  title="没有符合筛选条件的地块"
                  description="可以调整潮位带 / 底质筛选条件，或直接重置筛选。"
                  actionText="重置筛选"
                  onAction={resetFilters}
                />
              ),
            }}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '新建修复地块' : `编辑地块 · ${editing.name}`}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        width={560}
      >
        {editingLocked ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={editing?.readOnly ? '该地块为只读留底' : '该地块已移交养护队'}
            description={
              editing?.readOnly
                ? '升级时基线补不齐，先只读留着；下方仅可核对地块名，其余档案不可改。'
                : '移交后项目部侧栽植/验收口径已冻结，只能核对地块名；移交后的管护与复查在养护管护台处理。'
            }
          />
        ) : null}
        <Form form={form} layout="vertical" initialValues={DEFAULT_DRAFT}>
          <Form.Item
            name="name"
            label="地块名"
            rules={[{ required: true, message: '请填写地块名' }, { max: 40, message: '地块名不超过 40 字' }]}
          >
            <Input placeholder="如：东港南堤 3 号地块" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="areaMu"
              label="面积（亩）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写面积' }]}
            >
              <InputNumber min={0.1} max={5000} step={0.5} style={{ width: '100%' }} disabled={editingLocked} />
            </Form.Item>
            <Form.Item name="tideZone" label="潮位带" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select
                options={TIDE_ZONE_OPTIONS.map((value) => ({ value, label: value }))}
                disabled={editingLocked}
              />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="substrate" label="底质" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select
                options={SUBSTRATE_OPTIONS.map((value) => ({ value, label: value }))}
                disabled={editingLocked}
              />
            </Form.Item>
            <Form.Item name="restoreMode" label="修复方式" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select
                options={RESTORE_MODE_OPTIONS.map((value) => ({ value, label: value }))}
                disabled={editingLocked}
              />
            </Form.Item>
            <Form.Item name="state" label="跟踪状态" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select
                // 「已移交」只能由移交动作进入，表单里不可直接选
                options={(PLOT_STATE_OPTIONS.filter((value) => value !== '已移交') as PlotState[]).map((value) => ({
                  value,
                  label: value,
                }))}
                disabled={editingLocked}
              />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            地块「已验收」后可在台账执行「移交养护」：移交时把栽植总株数、成活株数、缺株数抄成基线两侧留底。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title={handoverTarget === null ? '移交养护队' : `移交养护队 · ${handoverTarget.name}`}
        open={handoverTarget !== null}
        onCancel={() => setHandoverTarget(null)}
        onOk={() => void handleHandover()}
        confirmLoading={handoverSubmitting}
        okText="确认移交并抄基线"
        cancelText="取消"
        width={560}
      >
        {handoverTarget !== null && handoverSummary !== null ? (
          <Space direction="vertical" size={12} style={{ display: 'flex' }}>
            <Alert
              type="info"
              showIcon
              message="按移交切开两侧数据"
              description="移交前的地块、栽植记录与验收测次归项目部（成活率停在移交当天那版）；移交后的管护作业单归养护队。以下三项会抄成基线，两边各自留底。"
            />
            <Card size="small" style={{ background: '#fbfdfc' }}>
              <Space size={24} wrap>
                <span>
                  栽植总株数：<b>{handoverSummary.totalCount.toLocaleString('zh-CN')}</b> 株
                </span>
                <span>
                  成活株数：<b>{handoverSummary.latest?.aliveCount.toLocaleString('zh-CN') ?? 0}</b> 株（第{' '}
                  {handoverSummary.latest?.round ?? '-'} 测次）
                </span>
                <span>
                  缺株数：
                  <b style={{ color: '#d08700' }}>{handoverSummary.suggestReplant.toLocaleString('zh-CN')}</b> 株
                </span>
                <span>
                  成活率：<b>{percentText(handoverSummary.latestRate)}</b>
                </span>
              </Space>
            </Card>
            <Form form={handoverForm} layout="vertical">
              <Form.Item name="handoverDate" label="移交日期" rules={[{ required: true, message: '请选择移交日期' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="note" label="移交备注">
                <Input.TextArea rows={2} placeholder="如：验收合格，现场移交养护队接管" />
              </Form.Item>
            </Form>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              若养护队那侧写不进去，只补跑养护队本侧，项目部侧留底不受影响；移交后补苗数与复查按此基线按地块对账。
            </Typography.Text>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
