import { useEffect, useMemo, useRef } from 'react';
import { init, use } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { AriaComponent, GridComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { Trend } from '../api/types';
import { number, trendMetrics } from './ReportCards';
import { Empty, reasonText } from './Feedback';

use([LineChart, AriaComponent, GridComponent, TooltipComponent, SVGRenderer]);
export function TrendChart({ data, timezone }: { data: Trend; timezone: string }) {
  const element = useRef<HTMLDivElement>(null);
  const labels = useMemo(
    () =>
      data.points.map((p) =>
        new Date(p.start).toLocaleString('zh-CN', {
          timeZone: timezone,
          month: '2-digit',
          day: '2-digit',
          ...(data.granularity === 'day'
            ? {}
            : { hour: '2-digit', minute: '2-digit', hour12: false }),
        }),
      ),
    [data, timezone],
  );
  const available = data.points.some((p) => p.value !== null);
  const summary = `${trendMetrics.find((m) => m.value === data.metric)?.label ?? data.metric} 趋势，共 ${data.points.length} 个时间桶，${data.points.filter((p) => p.value === null).length} 个不可用。时区 ${timezone}。UV/IP 按桶去重，不能相加作为范围总值。`;
  useEffect(() => {
    if (!element.current || !available) return;
    const chart = init(element.current, undefined, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      aria: { enabled: true, description: summary },
      grid: { left: 56, right: 24, top: 25, bottom: 44 },
      tooltip: {
        trigger: 'axis',
        renderMode: 'richText',
        valueFormatter: (v: unknown) => `${v ?? '不可用'} · ${timezone}`,
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: labels,
        axisLine: { lineStyle: { color: '#dee3e8' } },
        axisLabel: { color: '#65716a', hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { color: '#65716a' },
        splitLine: { lineStyle: { color: '#e9edf1' } },
      },
      series: [
        {
          type: 'line',
          name: data.metric.toUpperCase(),
          data: data.points.map((p) => p.value),
          smooth: false,
          connectNulls: false,
          showSymbol: data.points.length <= 14,
          symbolSize: 6,
          lineStyle: { width: 2, color: '#c77d58' },
          itemStyle: { color: '#b56846' },
          areaStyle: { color: '#c77d58', opacity: 0.06 },
        },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [data, labels, timezone, available, summary]);
  return (
    <>
      <p className="chart-summary">{summary}</p>
      {available ? (
        <div className="trend-chart" ref={element} />
      ) : (
        <Empty title="趋势数据暂不可用">
          {reasonText(data.points.find((p) => p.reason)?.reason)}
        </Empty>
      )}
      <details className="chart-table">
        <summary>查看趋势数据表</summary>
        <div className="table-wrap">
          <table>
            <caption>趋势数据（{timezone}）</caption>
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">数值</th>
                <th scope="col">状态</th>
              </tr>
            </thead>
            <tbody>
              {data.points.map((p, i) => (
                <tr key={p.start}>
                  <th scope="row">{labels[i]}</th>
                  <td>{number(p.value)}</td>
                  <td>
                    {p.reason ? reasonText(p.reason) : p.complete ? '完整时间桶' : '部分时间桶'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
