import { getServerTranslator } from "@/lib/i18n/server";
import { Check, CheckCircle2 } from "@/components/icons";
import { Card, CardContent, CardTitle } from "@/components/ui/card";

export default async function LicensesPage() {
  const t = await getServerTranslator();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-medium text-neutral-900">{t("licenses.title")}</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Self-hosted edition. All features and unlimited account seats are unlocked.
        </p>
      </div>

      <Card className="rounded-3xl border-0 bg-white px-6">
        <CardContent className="flex items-start gap-4 py-8">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-700">
            <CheckCircle2 className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle>{t("licenses.activated")}</CardTitle>
            <p className="mt-2 text-sm leading-6 text-neutral-600">
              Your Team license is active. All features are fully unlocked without limitations.
            </p>
            <p className="mt-1 text-sm text-neutral-500">{t("licenses.seatsUnlimited")}</p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="flex items-center gap-2 text-sm text-neutral-700">
                <Check className="h-4 w-4 text-green-600 shrink-0" />
                <span>Custom branding & app icons</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-neutral-700">
                <Check className="h-4 w-4 text-green-600 shrink-0" />
                <span>Unlimited managed user accounts</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-neutral-700">
                <Check className="h-4 w-4 text-green-600 shrink-0" />
                <span>Shared mailbox access & delegates</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-neutral-700">
                <Check className="h-4 w-4 text-green-600 shrink-0" />
                <span>Automatic email forwarding & routing</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
