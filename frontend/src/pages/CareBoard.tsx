/**
 * /care 管护作业单（养护队）
 * 地块移交后由养护队登记补苗与复查，按地块与移交基线对账：
 * 对不上或比基线多出的挂起复核，挂起期间不出补植计划；
 * 复查成活株数单独记在这里，不回写项目部验收测次（项目部口径冻结在移交当天）。
 * 消费模型：CareTask、Handover、Plot；复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  ToolOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { usePlotStore } from '../stores/plotStore';
import { useCareStore } from '../stores/careStore';
import { baselineRemaining } from '../types/handover';
import { CARE_KIND_OPTIONS, CARE_STATE_OPTIONS, type CareKind, type CareTask } from '../types/care';
import { percentText } from '../utils/rate';

interface CareFormValues {
  plotId: string;
  kind: CareKind;
  workDate: Dayjs;
  replantCount: number;
  recheckAliveCount: number;
}

export default function CareBoard() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const handovers = usePlotStore((state) => state.handovers);
  const careTasks = usePlotStore((state) => state.careTasks);
  const ready = usePlotStore((state) => state.ready);
  const handoverOf = usePlotStore((state) => state.handoverOf);
  const confirmedReplantOf = usePlotStore((state) => state.confirmedReplantOf);
  const hasSuspendedCare = usePlotStore((state) => state.hasSuspendedCare);

  const filters = useCareStore((state) => state.filters);
  const setFilters = useCareStore((state) => state.setFilters);
  const resetFilters = useCareStore((state) => state.resetFilters);
  const createTask = useCareStore((state) => state.createTask);
  const release = useCareStore((state) => state.release);
  const remove = useCareStore((state) => state.remove);
  const retryMaintenanceSide = useCareStore((state) => state.retryMaintenanceSide);
  const lastMessage = useCareStore((state) => state.lastMessage);

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<CareFormValues>();
  const watchKind = Form.useWatch('kind', form);

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  /** 养护队侧已建档的移交地块：可登记作业单 */
  const fileablePlots = useMemo(
    () =>
      plots.filter((plot) => {
        const handover = handoverOf(plot.id);
        return plot.handoverState === '已移交' && handover !== null && handover.maintenanceFiled;
      }),
    [plots, handoverOf],
  );

  /** 养护队侧写不进去（未建档）的移交单：只补跑本侧 */
  const pendingHandovers = useMemo(
    () => handovers.filter((row) => row.projectFrozen && !row.maintenanceFiled),
    [handovers],
  );

  const suspendedTasks = useMemo(() => careTasks.filter((row) => row.state === '挂起复核'), [careTasks]);

  const filtered = useMemo(() => {
    const key = filters.keyword.trim().toLowerCase();
    return careTasks
      .filter((row) => {
        if (filters.plotId !== 'all' && row.plotId !== filters.plotId) return false;
        if (filters.kind !== 'all' && row.kind !== filters.kind) return false;
        if (filters.state !== 'all' && row.state !== filters.state) return false;
        if (key === '') return true;
        return plotName(row.plotId).toLowerCase().includes(key) || row.workDate.includes(key);
      })
      .sort((a, b) => b.workDate.localeCompare(a.workDate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [careTasks, filters, plots]);

  /** 按地块对账：基线 vs 养护队已确认补苗 */
  const reconciliation = useMemo(
    () =>
      handovers
        .filter((row) => row.maintenanceFiled)
        .map((handover) => {
          const confirmed = confirmedReplantOf(handover.plotId);
          const rechecks = careTasks
            .filter((row) => row.plotId === handover.plotId && row.kind === '复查' && row.state === '正常')
            .sort((a, b) => b.workDate.localeCompare(a.workDate));
          return {
            handover,
            confirmed,
            remaining: baselineRemaining(handover.maintenanceCopy, confirmed),
            latestRecheck: rechecks.length > 0 ? rechecks[0] : null,
            suspended: hasSuspendedCare(handover.plotId),
          };
        }),
    [handovers, careTasks, confirmedReplantOf, hasSuspendedCare],
  );

  const stats = useMemo(
    () => ({
      total: careTasks.length,
      suspended: suspendedTasks.length,
      remaining: reconciliation.reduce((acc, row) => acc + row.remaining, 0),
      handedOver: handovers.length,
    }),
    [careTasks, suspendedTasks, reconciliation, handovers],
  );

  const openCreate = (): void => {
    const plotId = filters.plotId !== 'all' ? filters.plotId : fileablePlots.length > 0 ? fileablePlots[0].id : '';
    form.setFieldsValue({
      plotId,
      kind: '补苗',
      workDate: dayjs(),
      replantCount: 100,
      recheckAliveCount: 0,
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const row = await createTask({
        plotId: values.plotId,
        kind: values.kind,
        workDate: values.workDate.format('YYYY-MM-DD'),
        replantCount: values.kind === '补苗' ? values.replantCount : 0,
        recheckAliveCount: values.kind === '复查' ? values.recheckAliveCount : null,
      });
      if (row === null) {
        message.error('该地块未移交或养护队侧尚未建档，无法登记');
      } else if (row.state === '挂起复核') {
        message.warning(`已登记但挂起复核：${row.suspendReason}`, 8);
      } else {
        message.success('已登记，与移交基线对账一致');
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetry = async (handoverId: string): Promise<void> => {
    const ok = await retryMaintenanceSide(handoverId);
    if (ok) message.success('养护队侧补跑完成，基线已建档');
    else message.error('养护队侧补跑失败，请稍后再试');
  };

  const columns: ColumnsType<CareTask> = [
    {
      title: '地块',
      key: 'plot',
      width: 180,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{plotName(record.plotId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            移交单 {record.handoverId.slice(0, 18)}…
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '作业类型',
      dataIndex: 'kind',
      key: 'kind',
      width: 96,
      render: (value: CareKind) => <Tag color={value === '补苗' ? 'green' : 'blue'}>{value}</Tag>,
    },
    { title: '作业日期', dataIndex: 'workDate', key: 'workDate', width: 120, sorter: (a, b) => a.workDate.localeCompare(b.workDate) },
    {
      title: '数量',
      key: 'amount',
      width: 150,
      align: 'right',
      render: (_value, record) =>
        record.kind === '补苗' ? (
          `补苗 ${record.replantCount.toLocaleString('zh-CN')} 株`
        ) : (
          <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
            <span>成活 {record.recheckAliveCount?.toLocaleString('zh-CN') ?? '—'} 株</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              养护队复查，单独记
            </Typography.Text>
          </Space>
        ),
    },
    {
      title: '对账状态',
      key: 'state',
      width: 110,
      render: (_value, record) =>
        record.state === '挂起复核' ? (
          <Tag icon={<WarningOutlined />} color="orange">
            挂起复核
          </Tag>
        ) : (
          <Tag icon={<CheckOutlined />} color="green">
            正常
          </Tag>
        ),
    },
    {
      title: '挂起原因',
      dataIndex: 'suspendReason',
      key: 'suspendReason',
      width: 320,
      render: (value: string) =>
        value === '' ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            {value}
          </Typography.Text>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 190,
      fixed: 'right',
      render: (_value, record) => (
        <Space size={4} wrap>
          {record.state === '挂起复核' ? (
            <Popconfirm
              title="复核通过并解除挂起？"
              description="解除后该笔计入已确认补苗累计，请确认已与项目部核对基线。"
              okText="解除挂起"
              cancelText="再想想"
              onConfirm={() => void release(record.id)}
            >
              <Button size="small" type="link" icon={<CheckOutlined />}>
                复核放行
              </Button>
            </Popconfirm>
          ) : null}
          <Popconfirm
            title="确认删除该作业单？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void remove(record.id)}
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
        <StatBadge label="管护作业单" value={stats.total} suffix="条" tone="primary" icon={<ToolOutlined />} />
        <StatBadge
          label="挂起复核"
          value={stats.suspended}
          suffix="条"
          tone={stats.suspended > 0 ? 'warning' : 'default'}
          hint="对不上或比基线多出的作业单；挂起期间不出补植计划"
        />
        <StatBadge label="已移交地块" value={stats.handedOver} suffix="块" tone="info" />
        <StatBadge
          label="剩余可补缺株"
          value={stats.remaining.toLocaleString('zh-CN')}
          suffix="株"
          tone="danger"
          hint="各已移交地块「基线缺株 - 已确认补苗」合计"
        />
      </div>

      {pendingHandovers.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${pendingHandovers.length} 个地块养护队侧未建档（项目部侧已冻结）`}
          description={
            <Space direction="vertical" size={4}>
              {pendingHandovers.map((row) => (
                <Space key={row.id} size={8}>
                  <span>
                    {plotName(row.plotId)}：移交 {row.handoverDate}，基线缺株 {row.projectCopy.missingCount} 株
                  </span>
                  <Button size="small" icon={<ReloadOutlined />} onClick={() => void handleRetry(row.id)}>
                    补跑养护队侧
                  </Button>
                </Space>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                只补跑养护队侧，项目部侧留底不动。
              </Typography.Text>
            </Space>
          }
        />
      ) : null}

      {suspendedTasks.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${suspendedTasks.length} 条作业单挂起复核，涉及地块在挂起期间不出补植计划`}
          description={
            <Space direction="vertical" size={2}>
              {suspendedTasks.map((row) => (
                <span key={row.id}>
                  {plotName(row.plotId)} · {row.kind} · {row.workDate}：{row.suspendReason}
                </span>
              ))}
            </Space>
          }
        />
      ) : null}

      {lastMessage !== '' ? <Alert type="info" showIcon style={{ marginBottom: 14 }} message={lastMessage} /> : null}

      <Card title="按地块对账（移交基线 vs 养护队已确认）" style={{ marginBottom: 14 }} styles={{ body: { paddingTop: 12 } }}>
        {reconciliation.length === 0 ? (
          <EmptyPanel
            title="还没有已移交的地块"
            description="地块验收合格后在地块台账执行移交，系统会把栽植总株数、成活株数、缺株数抄成基线，两边各自留底。"
          />
        ) : (
          <Table
            rowKey={(row) => row.handover.id}
            size="small"
            pagination={false}
            dataSource={reconciliation}
            columns={[
              { title: '地块', key: 'plot', render: (_v, row) => plotName(row.handover.plotId) },
              { title: '移交日期', key: 'date', width: 110, render: (_v, row) => row.handover.handoverDate },
              {
                title: '基线（总株数 / 成活 / 缺株）',
                key: 'baseline',
                width: 220,
                render: (_v, row) =>
                  `${row.handover.maintenanceCopy.totalCount.toLocaleString('zh-CN')} / ${row.handover.maintenanceCopy.aliveCount.toLocaleString('zh-CN')} / ${row.handover.maintenanceCopy.missingCount.toLocaleString('zh-CN')} 株`,
              },
              {
                title: '移交成活率（冻结）',
                key: 'rate',
                width: 130,
                render: (_v, row) => percentText(row.handover.projectCopy.survivalRate),
              },
              {
                title: '已确认补苗',
                key: 'confirmed',
                width: 110,
                align: 'right',
                render: (_v, row) => `${row.confirmed.toLocaleString('zh-CN')} 株`,
              },
              {
                title: '剩余可补',
                key: 'remaining',
                width: 110,
                align: 'right',
                render: (_v, row) => (
                  <Typography.Text type={row.remaining > 0 ? 'warning' : 'success'}>
                    {row.remaining.toLocaleString('zh-CN')} 株
                  </Typography.Text>
                ),
              },
              {
                title: '最新复查成活',
                key: 'recheck',
                width: 150,
                render: (_v, row) =>
                  row.latestRecheck !== null
                    ? `${row.latestRecheck.recheckAliveCount?.toLocaleString('zh-CN') ?? '—'} 株（${row.latestRecheck.workDate}）`
                    : '—',
              },
              {
                title: '对账',
                key: 'state',
                width: 100,
                render: (_v, row) =>
                  row.suspended ? <Tag color="orange">挂起中</Tag> : <Tag color="green">一致</Tag>,
              },
            ]}
          />
        )}
      </Card>

      <Card
        title="管护作业单（养护队）"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={fileablePlots.length === 0}>
            登记作业单
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
              options: plots.map((plot) => plot.id),
              optionLabels: Object.fromEntries(plots.map((plot) => [plot.id, plot.name])),
            },
            { key: 'kind', label: '类型', options: [...CARE_KIND_OPTIONS] },
            { key: 'state', label: '状态', options: [...CARE_STATE_OPTIONS] },
          ]}
          values={{ plotId: filters.plotId, kind: filters.kind, state: filters.state }}
          onChange={(key: string, value: string) => {
            if (key === 'plotId') setFilters({ plotId: value });
            if (key === 'kind') setFilters({ kind: value as CareKind | 'all' });
            if (key === 'state') setFilters({ state: value as CareTask['state'] | 'all' });
          }}
          onReset={resetFilters}
          resultText={`命中 ${filtered.length} / ${careTasks.length} 条`}
        />

        {careTasks.length === 0 && ready ? (
          <EmptyPanel
            title="还没有管护作业单"
            description="地块移交后，养护队在这里登记补苗与复查；系统会按移交基线自动对账，对不上或比基线多出的挂起复核。"
            actionText={fileablePlots.length > 0 ? '登记第一条作业单' : undefined}
            onAction={fileablePlots.length > 0 ? openCreate : undefined}
          />
        ) : (
          <Table<CareTask>
            rowKey="id"
            size="middle"
            loading={!ready}
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1280 }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: <EmptyPanel title="没有符合筛选条件的作业单" actionText="重置筛选" onAction={resetFilters} />,
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
          <Form.Item name="plotId" label="地块（仅已移交）" rules={[{ required: true, message: '请选择地块' }]}>
            <Select
              options={fileablePlots.map((plot) => {
                const handover = handoverOf(plot.id);
                const remaining = handover !== null ? baselineRemaining(handover.maintenanceCopy, confirmedReplantOf(plot.id)) : 0;
                return { value: plot.id, label: `${plot.name}（剩余可补 ${remaining} 株）` };
              })}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="kind" label="作业类型" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={CARE_KIND_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item name="workDate" label="作业日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          {watchKind !== '复查' ? (
            <Form.Item
              name="replantCount"
              label="补苗数（株）"
              rules={[{ required: true, message: '请填写补苗数' }]}
              extra="超过基线剩余缺株会挂起复核"
            >
              <InputNumber min={1} max={200000} step={10} style={{ width: '100%' }} />
            </Form.Item>
          ) : (
            <Form.Item
              name="recheckAliveCount"
              label="复查成活株数"
              rules={[{ required: true, message: '请填写复查成活株数' }]}
              extra="养护队复查单独记，不回写项目部验收；超过基线口径会挂起复核"
            >
              <InputNumber min={0} max={500000} step={10} style={{ width: '100%' }} />
            </Form.Item>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            保存时自动与移交基线对账：对不上或比基线多出的挂起复核，挂起期间该地块不出补植计划。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
