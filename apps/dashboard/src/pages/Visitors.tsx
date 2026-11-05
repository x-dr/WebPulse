import { useReport } from '../api/reports';
import type { Visitors } from '../api/types';
import type { Scope } from '../navigation';
import { Failure, Loading } from '../components/Feedback';
import { ReportStatus, VisitorCards } from '../components/ReportCards';
import { TrendPanel } from './Overview';

export function VisitorsPage({ scope }: { scope: Scope }) {
  const query = useReport<Visitors>('visitors', scope);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">初次遇见，再次回来</p>
          <h1>访客分析</h1>
        </div>
      </div>
      <p className="page-description">
        按整个所选周期划分新老访客。UV 按浏览器身份去重，不代表实名人数，不合并跨设备身份。
      </p>
      {query.isError ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : query.data ? (
        <>
          <VisitorCards report={query.data} />
          <ReportStatus report={query.data} />
        </>
      ) : (
        <Loading />
      )}
      <TrendPanel scope={scope} visitorOnly />
    </>
  );
}
