export type TxType = "expense" | "income" | "transfer" | "debt";
export type DebtDirection = "borrow" | "repay" | "lend" | "collect";
export type Recurrence = "none" | "daily" | "weekly" | "monthly";

export interface User {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  currency: string;
  timezone: string;
  monthly_budget: number;
  initial_balance: number;
}

export interface Category {
  id: number;
  user_id: number | null;
  name: string;
  type: TxType;
  icon: string;
  color: string;
}

export interface ReceiptItem {
  name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
}

export interface ReceiptData {
  merchant_name: string;
  items: ReceiptItem[];
  subtotal: number | null;
  tax: number | null;
  service_charge: number | null;
  discount: number | null;
  grand_total: number;
  transaction_date: string | null;
  category: string;
  payment_method: string;
  currency: string;
}

export interface Transaction {
  id: number;
  type: TxType;
  amount: number;
  category_id: number | null;
  description: string;
  merchant: string | null;
  payment_method: string;
  debt_direction: DebtDirection | null;
  counterparty: string | null;
  transaction_date: string;
  source: "telegram_text" | "telegram_voice" | "telegram_receipt" | "dashboard";
  raw_input: string | null;
  receipt_data: ReceiptData | null;
  created_at: string;
  category: Pick<Category, "id" | "name" | "icon" | "color" | "type"> | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface DashboardSummary {
  period: string;
  currency: string;
  timezone: string;
  balance: number;
  monthly_income: number;
  monthly_expense: number;
  net_monthly: number;
  prev_month_income: number;
  prev_month_expense: number;
  total_debt: number;
  total_receivable: number;
  transaction_count: number;
  budget: { amount: number; spent: number; remaining: number; percent: number } | null;
  category_breakdown: {
    category_id: number | null;
    name: string;
    icon: string;
    color: string;
    total: number;
    count: number;
    percent: number;
  }[];
  daily: { date: string; income: number; expense: number }[];
  recent_transactions: Transaction[];
}

export interface FinancialInsight {
  health_score: number;
  status: "excellent" | "good" | "fair" | "poor";
  headline: string;
  summary: string;
  highlights: string[];
  recommendations: string[];
}

export interface InsightResponse {
  period: string;
  cached: boolean;
  generated_at: string;
  insight: FinancialInsight;
  empty?: boolean;
}

export interface Reminder {
  id: number;
  task: string;
  amount: number | null;
  remind_at: string;
  recurrence: Recurrence;
  status: "pending" | "sending" | "sent" | "failed" | "cancelled";
  last_sent_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface TransactionFilters {
  search?: string;
  type?: TxType | "";
  category_id?: string;
  date_from?: string;
  date_to?: string;
  sort?: "transaction_date" | "amount" | "created_at";
  dir?: "asc" | "desc";
  page?: number;
  page_size?: number;
}

export interface TransactionInput {
  type: TxType;
  amount: number;
  category_id: number | null;
  description: string;
  merchant?: string | null;
  payment_method: string;
  debt_direction?: DebtDirection | null;
  counterparty?: string | null;
  transaction_date: string;
}
