"use client";
import { useState, useCallback } from "react";
import { Networks } from "@creit.tech/stellar-wallets-kit";
import { useStellar } from "@/components/stellar/StellarProvider";
import { toast } from "sonner";
import axiosInstance from "@/lib/config/axios.config";

/** Envelope fields the donation API uses to signal success or failure. */
interface DonationApiEnvelope {
  success?: boolean;
  message?: string;
}

/** Body returned by POST /api/stellar/donation/initialize. */
export interface InitializeDonationApiResponse extends DonationApiEnvelope {
  donationId: string;
  transactionXdr: string;
  networkPassphrase?: string;
  [key: string]: unknown;
}

export interface InitializeDonationParams {
  amount: number | string;
}

/** Initialize response plus the requested amount, which the hook adds client-side. */
export interface InitializeDonationResult extends InitializeDonationApiResponse {
  amount: number | string;
}

/** Body returned by GET /api/stellar/donation/stats. */
export interface DonationStatsResult extends DonationApiEnvelope {
  success: boolean;
  unconfigured?: boolean;
  message?: string;
  [key: string]: unknown;
}

/** Body returned by POST /api/stellar/donation/submit. */
export interface DonationSubmitResult extends DonationApiEnvelope {
  txHash?: string;
  [key: string]: unknown;
}

/** Fields of a prepared donation that executeDonation consumes. */
export type ExecuteDonationInput = Pick<
  InitializeDonationResult,
  "donationId" | "transactionXdr" | "networkPassphrase"
>;

export interface UseStellarDonationResult {
  initializeDonation: (params: InitializeDonationParams) => Promise<InitializeDonationResult | null>;
  executeDonation: (donationData: ExecuteDonationInput | null) => Promise<DonationSubmitResult | false>;
  cancelDonation: () => void;
  getDonationStats: () => Promise<DonationStatsResult>;
  isProcessing: boolean;
  currentDonation: InitializeDonationResult | null;
}

/** Shape of an Axios-style error; every field is optional because thrown values vary. */
interface RequestErrorShape {
  response?: { status?: number; data?: { message?: string } };
  message?: string;
}

function readErrorDetails(error: unknown): { status?: number; message?: string } {
  if (typeof error !== "object" || error === null) return {};
  const { response, message } = error as RequestErrorShape;
  return { status: response?.status, message: response?.data?.message || message };
}

/** Minimal Sentry surface used here; the SDK is loaded lazily. */
interface SentryScopeLike {
  setTag(key: string, value: string): void;
}

interface SentryLike {
  captureException(error: unknown): void;
  withScope(callback: (scope: SentryScopeLike) => void): void;
}

function isSentryLike(value: unknown): value is SentryLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "captureException" in value &&
    typeof value.captureException === "function" &&
    "withScope" in value &&
    typeof value.withScope === "function"
  );
}

function resolveSentryModule(mod: unknown): unknown {
  if (typeof mod === "object" && mod !== null && "default" in mod && mod.default != null) {
    return mod.default;
  }
  return mod;
}

export const useStellarDonation = (): UseStellarDonationResult => {
  const { connectedWallet, signTransaction, refreshBalance, network } =
    useStellar();
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [currentDonation, setCurrentDonation] = useState<InitializeDonationResult | null>(null);

  const initializeDonation = useCallback(
    async ({ amount }: InitializeDonationParams): Promise<InitializeDonationResult | null> => {
      if (!connectedWallet) {
        toast.error("Please connect your wallet first");
        return null;
      }

      setIsProcessing(true);
      try {
        const res = await axiosInstance.post<InitializeDonationApiResponse>(
          "/api/stellar/donation/initialize",
          {
            amount,
            publicKey: connectedWallet,
          }
        );

        if (res.data.success !== false) {
          const donation: InitializeDonationResult = { ...res.data, amount };
          setCurrentDonation(donation);
          return donation;
        } else {
          throw new Error(res.data.message);
        }
      } catch (error: unknown) {
        const { status, message } = readErrorDetails(error);
        if (status === 503) {
          toast.error("Donations are not available right now. Please try again later.");
        } else {
          toast.error(message);
        }
        return null;
      } finally {
        setIsProcessing(false);
      }
    },
    [connectedWallet]
  );

  const executeDonation = useCallback(
    async (donationData: ExecuteDonationInput | null): Promise<DonationSubmitResult | false> => {
      if (!donationData) {
        toast.error("No donation data available");
        return false;
      }

      setIsProcessing(true);
      try {
        const networkPassphrase =
          donationData.networkPassphrase ||
          (network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET);
        const signedXdr = await signTransaction(
          donationData.transactionXdr,
          networkPassphrase
        );

        const res = await axiosInstance.post<DonationSubmitResult>(
          "/api/stellar/donation/submit",
          {
            donationId: donationData.donationId,
            signedXdr,
          }
        );

        if (res.data.success) {
          toast.success("JazakAllahu khairan! Donation successful!");

          await refreshBalance();

          setCurrentDonation(null);
          return res.data;
        } else {
          throw new Error(res.data.message);
        }
      } catch (error: unknown) {
        import("@sentry/nextjs")
          .then((mod: unknown) => {
            const Sentry = resolveSentryModule(mod);
            if (!isSentryLike(Sentry)) return;
            Sentry.withScope((scope) => {
              scope.setTag("feature", "stellar-donation");
              Sentry.captureException(error);
            });
          })
          .catch(() => {});

        const message = readErrorDetails(error).message ?? "";

        if (message.includes("insufficient") || message.includes("underfunded")) {
          toast.error("Insufficient USDC balance");
        } else if (message.includes("op_no_trust") || message.includes("trustline")) {
          toast.error(
            "You need to add USDC trustline to your wallet first"
          );
        } else if (message.includes("rejected") || message.includes("cancelled")) {
          toast.error("Transaction was cancelled");
        } else {
          toast.error(`Donation failed: ${message}`);
        }
        return false;
      } finally {
        setIsProcessing(false);
      }
    },
    [signTransaction, refreshBalance, network]
  );

  const cancelDonation = useCallback((): void => {
    setCurrentDonation(null);
  }, []);

  const getDonationStats = useCallback(async (): Promise<DonationStatsResult> => {
    try {
      const res = await axiosInstance.get<DonationStatsResult>("/api/stellar/donation/stats");
      return res.data;
    } catch (error: unknown) {
      console.error("Failed to fetch donation stats:", error);
      const { status, message } = readErrorDetails(error);
      return {
        success: false,
        unconfigured: status === 503,
        message,
      };
    }
  }, []);

  return {
    initializeDonation,
    executeDonation,
    cancelDonation,
    getDonationStats,
    isProcessing,
    currentDonation,
  };
};

export default useStellarDonation;
