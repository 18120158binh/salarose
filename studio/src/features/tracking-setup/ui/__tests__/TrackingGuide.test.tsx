import { act, fireEvent, render, screen } from "@testing-library/react";
import { UTC } from "@/shared/lib/time-range";
import { SendDataGuide } from "@/features/data-ingestion/ui/SendDataGuide";
import { trackingPlan } from "../../model/plan";
import { TrackingGuide, type TrackingGuideProps } from "../TrackingGuide";

const PLAN = Promise.resolve(trackingPlan(0, [], { product_viewed: [], add_to_cart: [], order_completed: [] }));

async function renderGuide(props: Pick<TrackingGuideProps, "collector" | "appIds">) {
  await act(async () => {
    render(
      <TrackingGuide
        {...props}
        admin={false}
        arrivals={Promise.resolve([])}
        eventsUrl="https://studio.example.com/v1/events"
        now={Date.parse("2026-11-08T09:00:00Z")}
        plan={PLAN}
        zone={UTC}
      />,
    );
  });
}

describe("TrackingGuide setup values (DHL-FR-15, DHL-FR-16)", () => {
  it("puts the deployment's collector address and app id in the install sample", async () => {
    await renderGuide({ collector: "https://collect.acme.com", appIds: ["acme-web"] });
    expect(screen.getByLabelText("Collector address")).toHaveValue("https://collect.acme.com");
    expect(screen.getByLabelText("App id")).toHaveValue("acme-web");
    expect(screen.getByText(/newTracker\('sp', 'https:\/\/collect\.acme\.com'/)).toBeInTheDocument();
    expect(screen.getByText(/appId: 'acme-web'/)).toBeInTheDocument();
    expect(screen.queryByText(/Studio does not know it yet/)).not.toBeInTheDocument();
  });

  it("names the other app ids when there are several", async () => {
    await renderGuide({ collector: "https://collect.acme.com", appIds: ["acme-web", "acme-app"] });
    expect(screen.getByLabelText("App id")).toHaveValue("acme-web");
    expect(screen.getByText(/Your other sites and apps use acme-app\./)).toBeInTheDocument();
  });

  it("shows placeholders and says Studio does not know them when unset", async () => {
    await renderGuide({ collector: null, appIds: [] });
    expect(screen.getByLabelText("Collector address")).toHaveValue("https://<collector address>");
    expect(screen.getByLabelText("App id")).toHaveValue("<app id>");
    expect(screen.getAllByText(/Studio does not know it yet/)).toHaveLength(2);
  });

  it("sends server person events to POST /v1/events at Studio's address", async () => {
    await renderGuide({ collector: "https://collect.acme.com", appIds: ["acme-web"] });
    fireEvent.click(screen.getByRole("button", { name: /Server \(HTTP API\)/ }));
    expect(screen.queryByText(/Coming later/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Address")).toHaveValue("https://studio.example.com/v1/events");
    expect(screen.getByText(/POST https:\/\/studio\.example\.com\/v1\/events/)).toBeInTheDocument();
  });
});

describe("SendDataGuide setup values (DHL-FR-16, DHL-FR-17)", () => {
  it("samples POST /v1/events at the ingestion address", () => {
    render(<SendDataGuide origin="https://api.acme.com" />);
    expect(screen.getByText(/curl -X POST https:\/\/api\.acme\.com\/v1\/events/)).toBeInTheDocument();
    expect(screen.getByText(/Up to 500 events or 1 MB per request/)).toBeInTheDocument();
  });

  it("shows a placeholder when Studio's address is unset", () => {
    render(<SendDataGuide origin={null} />);
    expect(screen.getByText(/curl -X POST https:\/\/<studio address>\/v1\/events/)).toBeInTheDocument();
  });
});
