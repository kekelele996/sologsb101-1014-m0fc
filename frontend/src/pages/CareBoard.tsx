/**
 * /care 养护管护台（移交后归养护队）
 * 登记移交后的管护作业单：补苗上报与复查，按地块与移交基线对账。
 * - 对不上基线 / 累计补苗超出基线缺株数的作业单自动挂起复核；
 * - 挂起期间不出补植计划；
 * - 复查成活株数单独记，不回写项目部验收（项目部那份成活率停在移交当天）。
 * 消费模型：CareRecheck、Plot、HandoverBaseline；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>
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
  CheckCircleOutlined,
  DeleteOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useCareStore } from '../stores/careStore';
import { db } from '../utils/db';
import { CARE_RECONCILE_LABEL, type CareRecheck, type CareRecheckDraft, type CareTaskKind } from '../types/care';
import { SEEDLING_SPECIES_OPTIONS, type SeedlingSpecies } from '../types/seedling';
import { reconcileStatusColor } from '../utils/baseline';

interface CareFormValues {
  plotId: string;
  kind: CareTaskKind;
  date: Dayjs;
  replantCount: number;
  aliveCount: number;
  avgHeightCm: number;
  species: SeedlingSpecies;
  crew: string;
  note: string;
}

const HOLDABLE = new Set(['normal', 'mismatch', 'overBaseline']);
const RESOLVABLE = new Set(['held', 'mismatch', 'overBaseline']);

export default function CareBoard() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const ready = usePlotStore((state) => state.ready);
  const careBaselineOf = usePlotStore((state) => state.careBaselineOf);
  const ledgerOf = useCareStore((state) => state.ledgerOf);
  const filters = useCareStore((state) => state.filters);
  const setFilters = useCareStore((state) => state.setFilters);
  const resetFilters = useCareStore((state) => state.resetFilters);
  const lastMessage = useCareStore((state) => state.lastMessage);
  const createJob = useCareStore((state) => state.createJob);
  const holdJob = useCareStore((state) => state.holdJob);
  const resolveJob = useCareStore((state) => state.resolveJob);
  const deleteJob = useCareStore((state) => state.deleteJob);

  const { rows, loading } = useIdbTable<CareRecheck>(db.careRechecks, { sortByUpdatedAt: false });

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<CareFormValues>();
  const formKind = Form.useWatch('kind', form);

  /** 只有已移交、且养护侧基线留底齐全的地块才能登记管护作业 */
  const handedPlots = useMemo(
    () => plots.filter((plot) => plot.state === '已移交' && careBaselineOf(plot.id) !== undefined),
    [plots, careBaselineOf],
  );
  const readOnlyPlots = useMemo(() => plots.filter((plot) => plot.readOnly === true), [plots]);

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  const filtered = useMemo(() => {
    const key = filters.keyword.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (filters.plotId !== 'all' && row.plotId !== filters.plotId) return false;
        if (filters.kind !== 'all' && row.kind !== filters.kind) return false;
        if (filters.status !== 'all' && row.status !== filters.status) return false;
        if (key === '') return true;
        return (
          plotName(row.plotId).toLowerCase().includes(key) ||
          row.crew.toLowerCase().includes(key) ||
          row.species.toLowerCase().includes(key) ||
          row.note.toLowerCase().includes(key)
        );
      })
      .sort((a, b) => b.date.localeCompare(a.date) || a.plotId.localeCompare(b.plotId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters, plots]);

  const stats = useMemo(() => {
    const held = rows.filter((row) => RESOLVABLE.has(row.status) && row.status !== 'resolved');
    const replantJobs = rows.filter((row) => row.kind === '补苗');
    const accepted = replantJobs
      .filter((row) => row.status === 'normal' || row.status === 'resolved')
      .reduce((acc, row) => acc + row.replantCount, 0);
    const pending = replantJobs
      .filter((row) => HOLDABLE.has(row.status) && row.status !== 'normal')
      .reduce((acc, row) => acc + row.replantCount, 0);
    const recheckCount = rows.filter((row) => row.kind === '复查').length;
    return { heldCount: held.length, accepted, pending, recheckCount, total: rows.length };
  }, [rows]);

  const selectedLedger = filters.plotId !== 'all' ? ledgerOf(filters.plotId) : null;

  const openCreate = (): void => {
    const plotId =
      filters.plotId !== 'all' && handedPlots.some((plot) => plot.id === filters.plotId)
        ? filters.plotId
        : handedPlots.length > 0
          ? handedPlots[0].id
          : '';
    form.setFieldsValue({
      plotId,
      kind: '补苗',
      date: dayjs(),
      replantCount: 0,
      aliveCount: 0,
      avgHeightCm: 0,
      species: plots.find((plot) => plot.id === plotId) ? '无瓣海桑' : '秋茄',
      crew: '',
      note: '',
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload: CareRecheckDraft = {
        plotId: values.plotId,
        kind: values.kind,
        date: values.date.format('YYYY-MM-DD'),
        replantCount: values.kind === '补苗' ? values.replantCount : 0,
        aliveCount: values.kind === '复查' ? values.aliveCount : 0,
        avgHeightCm: values.avgHeightCm ?? 0,
        species: values.species,
        crew: values.crew.trim(),
        note: values.note?.trim() ?? '',
      };
      await createJob(payload);
      message.success('管护作业单已登记');
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleHold = async (row: CareRecheck): Promise<void> => {
    try {
      await holdJob(row.id, row.note ? `${row.note}（人工挂起复核）` : '人工挂起复核');
      message.warning('已挂起复核，挂起期间不出补植计划');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '挂起失败');
    }
  };

  const handleResolve = async (row: CareRecheck): Promise<void> => {
    try {
      await resolveJob(row.id, row.note ? `${row.note}（复核放行）` : '复核放行');
      message.success('复核通过，作业单已放行');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '复核失败');
    }
  };

  const columns: ColumnsType<CareRecheck> = [
    {
      title: '地块',
      key: 'plot',
      width: 180,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{plotName(record.plotId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            批次 {record.batch.slice(-10)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '作业',
      dataIndex: 'kind',
      key: 'kind',
      width: 90,
      render: (value: CareTaskKind) => <Tag color={value === '补苗' ? 'green' : 'geekblue'}>{value}</Tag>,
    },
    { title: '作业日期', dataIndex: 'date', key: 'date', width: 120, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '补苗数（株）',
      dataIndex: 'replantCount',
      key: 'replantCount',
      width: 120,
      align: 'right',
      render: (value: number) => (value > 0 ? value.toLocaleString('zh-CN') : '—'),
    },
    {
      title: '复查成活株数',
      dataIndex: 'aliveCount',
      key: 'aliveCount',
      width: 130,
      align: 'right',
      render: (value: number, record) => (record.kind === '复查' ? value.toLocaleString('zh-CN') : '—'),
    },
    {
      title: '株高（cm）',
      dataIndex: 'avgHeightCm',
      key: 'avgHeightCm',
      width: 100,
      align: 'right',
      render: (value: number) => (value > 0 ? value : '—'),
    },
    { title: '树种', dataIndex: 'species', key: 'species', width: 100, render: (v: string) => <Tag>{v}</Tag> },
    { title: '班组', dataIndex: 'crew', key: 'crew', width: 110 },
    {
      title: '对账状态',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (value: CareRecheck['status']) => (
        <Tag color={reconcileStatusColor(value)}>{CARE_RECONCILE_LABEL[value]}</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 230,
      fixed: 'right',
      render: (_value, record) => (
        <Space size={4} wrap>
          {record.status === 'normal' ? (
            <Tooltip title="对不上先挂起复核，挂起期间不出补植计划">
              <Button size="small" type="link" icon={<PauseCircleOutlined />} onClick={() => void handleHold(record)}>
                挂起
              </Button>
            </Tooltip>
          ) : null}
          {RESOLVABLE.has(record.status) ? (
            <Button size="small" type="link" style={{ color: '#0f766e' }} icon={<CheckCircleOutlined />} onClick={() => void handleResolve(record)}>
              复核放行
            </Button>
          ) : null}
          <Popconfirm
            title="确认删除该管护作业单？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await deleteJob(record.id);
              message.success('管护作业单已删除');
            }}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="管护作业单" value={stats.total} suffix="张" tone="primary" icon={<ToolOutlined />} />
        <StatBadge label="其中复查单" value={stats.recheckCount} suffix="张" tone="info" />
        <StatBadge
          label="已放行补苗"
          value={stats.accepted.toLocaleString('zh-CN')}
          suffix="株"
          tone="success"
          hint="与基线对账一致或复核放行后的累计补苗数"
        />
        <StatBadge
          label="挂起待核补苗"
          value={stats.pending.toLocaleString('zh-CN')}
          suffix="株"
          tone={stats.pending > 0 ? 'danger' : 'default'}
        />
        <StatBadge
          label="挂起作业单"
          value={stats.heldCount}
          suffix="张"
          tone={stats.heldCount > 0 ? 'warning' : 'default'}
          hint="挂起复核期间不出补植计划"
        />
      </div>

      {stats.heldCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${stats.heldCount} 张管护作业单挂起复核中`}
          description="补苗数与基线对不上、或累计补苗超出基线缺株数。挂起期间该地块不出补植计划，核对清楚后点「复核放行」。"
        />
      ) : null}

      {readOnlyPlots.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${readOnlyPlots.length} 个地块为升级补不齐基线的只读留底`}
          description="这些地块缺少栽植或验收数据，暂时只读留着，不能登记管护作业；补齐基线后再开放对账。"
        />
      ) : null}

      {lastMessage !== '' ? (
        <Alert type="info" showIcon style={{ marginBottom: 14 }} message={lastMessage} />
      ) : null}

      {selectedLedger !== null ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 14 }}
          icon={<SafetyCertificateOutlined />}
          message={`${plotName(filters.plotId as string)} · 移交基线对账`}
          description={
            <Space size={24} wrap>
              <span>基线缺株 {selectedLedger.baselineMissing.toLocaleString('zh-CN')} 株</span>
              <span>基线成活 {selectedLedger.baselineAlive.toLocaleString('zh-CN')} 株</span>
              <span>基线栽植 {selectedLedger.baselineTotal.toLocaleString('zh-CN')} 株</span>
              <span>已放行补苗 {selectedLedger.acceptedReplant.toLocaleString('zh-CN')} 株</span>
              <span style={{ color: '#d08700' }}>挂起待核 {selectedLedger.pendingReplant.toLocaleString('zh-CN')} 株</span>
              <span>
                基线剩余可补 {Math.max(0, selectedLedger.baselineMissing - selectedLedger.acceptedReplant).toLocaleString('zh-CN')} 株
              </span>
              {selectedLedger.latestRecheckAlive !== null ? (
                <span>最近复查成活 {selectedLedger.latestRecheckAlive.toLocaleString('zh-CN')} 株（养护侧单独记）</span>
              ) : null}
            </Space>
          }
        />
      ) : null}

      <Card
        title="养护管护台（移交后）"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={handedPlots.length === 0}>
            登记管护作业单
          </Button>
        }
      >
        <FilterBar
          keyword={filters.keyword}
          onKeywordChange={(value: string) => setFilters({ keyword: value })}
          fields={[
            {
              key: 'plotId',
              label: '地块',
              options: handedPlots.map((plot) => plot.id),
              optionLabels: Object.fromEntries(handedPlots.map((plot) => [plot.id, plot.name])),
            },
            { key: 'kind', label: '作业', options: ['补苗', '复查'] },
            {
              key: 'status',
              label: '对账状态',
              options: ['normal', 'mismatch', 'overBaseline', 'held', 'resolved'],
              optionLabels: CARE_RECONCILE_LABEL,
            },
          ]}
          values={{ plotId: filters.plotId, kind: filters.kind, status: filters.status}}
          onChange={(key: string, value: string) => {
            if (key === 'plotId') setFilters({ plotId: value });
            if (key === 'kind') setFilters({ kind: value as CareTaskKind | 'all' });
            if (key === 'status') setFilters({ status: value as CareRecheck['status'] | 'all' });
          }}
          onReset={resetFilters}
          resultText={`命中 ${filtered.length} / ${rows.length} 张`}
        />

        {rows.length === 0 && !loading ? (
          <EmptyPanel
            title="还没有移交后的管护作业单"
            description="地块验收合格并移交后，把补苗上报与复查登记在这里；系统按移交基线按地块对账，对不上或超基线先挂起。"
            actionText="登记第一张作业单"
            onAction={openCreate}
          />
        ) : (
          <Table<CareRecheck>
            rowKey="id"
            size="middle"
            loading={loading || !ready}
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1500 }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: <EmptyPanel title="没有符合筛选条件的管护作业单" actionText="重置筛选" onAction={resetFilters} />,
            }}
          />
        )}
      </Card>

      <Modal
        title="登记管护作业单"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存并对账"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="plotId" label="已移交地块" style={{ flex: 2 }} rules={[{ required: true, message: '请选择地块' }]}>
              <Select
                options={handedPlots.map((plot) => ({
                  value: plot.id,
                  label: `${plot.name}（移交 ${plot.handoverDate}）`,
                }))}
              />
            </Form.Item>
            <Form.Item name="kind" label="作业类型" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select
                options={[
                  { value: '补苗', label: '补苗（按缺株）' },
                  { value: '复查', label: '复查（单独记）' },
                ]}
              />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="date" label="作业日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            {formKind === '补苗' ? (
              <Form.Item
                name="replantCount"
                label="本次补苗数（株）"
                style={{ flex: 1 }}
                rules={[{ required: true, message: '请填写补苗数' }]}
              >
                <InputNumber min={1} max={200000} step={10} style={{ width: '100%' }} />
              </Form.Item>
            ) : (
              <Form.Item
                name="aliveCount"
                label="复查成活株数"
                style={{ flex: 1 }}
                rules={[{ required: true, message: '请填写复查成活株数' }]}
              >
                <InputNumber min={0} max={500000} step={10} style={{ width: '100%' }} />
              </Form.Item>
            )}
            <Form.Item name="avgHeightCm" label="平均株高（cm）" style={{ flex: 1 }}>
              <InputNumber min={0} max={2000} step={1} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="species" label="树种" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SEEDLING_SPECIES_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item name="crew" label="作业班组" style={{ flex: 1 }} rules={[{ required: true, message: '请填写班组' }]}>
              <Input placeholder="如：养护一班" />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="补苗位置 / 复查情况说明（对不上时会据此挂起）" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            补苗数按地块与移交基线缺株数对账：累计超过基线或缺数据会自动挂起复核，挂起期间不出补植计划；
            复查成活株数只记在养护侧，不改项目部移交当天那版成活率。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
