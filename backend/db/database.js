const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email:           { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash:   { type: String, required: true },
  full_name:       { type: String, required: true, trim: true },
  role:            { type: String, required: true, enum: ['buyer', 'seller', 'admin'] },
  account_status:  { type: String, enum: ['active', 'warned', 'suspended', 'deletion_pending', 'deleted'], default: 'active' },
  deletion_requested_at: { type: Date, default: null },
  deletion_reason: { type: String, default: '' },
  deletion_reviewed_at: { type: Date, default: null },
  deletion_reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  deletion_approved_at: { type: Date, default: null },
  deletion_retention_until: { type: Date, default: null },
  // Seller onboarding approval. Existing sellers default to approved for backwards compatibility.
  seller_approval_status: { type: String, enum: ['approved','pending','rejected'], default: 'approved' },
  seller_approval_reason: { type: String, default: '' },
  seller_approval_requested_at: { type: Date, default: null },
  seller_approval_reviewed_at: { type: Date, default: null },
  seller_approval_reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  warn_reason:     { type: String, default: '' },
  suspend_reason:  { type: String, default: '' },
  warned_at:       { type: Date, default: null },
  suspended_at:    { type: Date, default: null },
  avatar_url:      { type: String, default: null },
  banner_url:      { type: String, default: null },
  bio:             { type: String, default: '' },
  university:      { type: String, default: 'Ajayi Crowther University' },
  location:        { type: String, default: 'Ajegunle, Oyo, Oyo State' },
  rating:          { type: Number, default: 0 },
  rating_count:    { type: Number, default: 0 },
  profile_health:   { type: Number, default: 100, min: 0, max: 100 },
  is_verified:     { type: Boolean, default: false },
  report_count:    { type: Number, default: 0, min: 0 },
  discoverability_score: { type: Number, default: 100, min: 0, max: 100 },
  listing_credits:  { type: Number, default: 1 },
  successful_sales_count: { type: Number, default: 0, min: 0 },
  commission_tier:  { type: Number, default: 1, min: 1, max: 4 },
  commission_percent: { type: Number, default: 7, min: 0, max: 100 },
  tier_unlocked_at: { type: Date, default: null },
  bank_name:        { type: String, default: '' },
  bank_code:        { type: String, default: '' },
  account_number:   { type: String, default: '' },
  account_name:     { type: String, default: '' },
  paystack_subaccount_code: { type: String, default: null },
  payout_status:    { type: String, default: 'not_configured', enum: ['not_configured','ready','pending','failed'] },
  payout_error:     { type: String, default: '' },
  admin_messages:   { type: [{
    title:           { type: String, default: '' },
    content:         String,
    sent_at:         Date,
    read:            { type: Boolean, default: false },      // kept for backward compatibility
    acknowledged:    { type: Boolean, default: false },
    acknowledged_at: { type: Date, default: null },
    broadcast_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', default: null },
  }], default: [] },
  used_payment_refs: { type: [String], default: [] },
  // Registration profile (filled after signup)
  registration_complete: { type: Boolean, default: false },
  // Seller-specific public info for pickup and delivery
  business_name:   { type: String, default: '' },
  seller_location_type: { type: String, enum: ['hostel','shop',''], default: '' },
  hostel_name:     { type: String, default: '' },
  level:           { type: String, default: '' },
  room_number:     { type: String, default: '' },
  shop_name:       { type: String, default: '' },
  shop_number:     { type: String, default: '' },
  shop_address:    { type: String, default: '' },
  delivery_info:   { type: String, default: '' },
  // ID verification docs (stored as Cloudinary URLs, admin reviews)
  id_type:         { type: String, default: '' }, // 'school_id' | 'nin' | 'national_id' | 'drivers_license'
  id_front_url:    { type: String, default: null },
  id_back_url:     { type: String, default: null },
  // Web Push subscriptions (array of PushSubscription objects)
  push_subscriptions: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // Email verification
  email_verified:         { type: Boolean, default: false },
  email_verify_token:     { type: String, default: null },
  email_verify_expires:   { type: Date,   default: null },
  // Password reset
  password_reset_token:   { type: String, default: null },
  password_reset_expires: { type: Date,   default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const listingSchema = new mongoose.Schema({
  seller_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:           { type: String, required: true, trim: true },
  description:     { type: String, required: true },
  price:           { type: Number, required: true },
  original_price:  { type: Number, default: null },
  category:        { type: String, required: true },
  condition:       { type: String, required: true, enum: ['New','Like New','Good','Fair'] },
  images:          { type: [String], default: [] },
  delivery_window:  { type: String, default: '1d', enum: ['5m','6h','12h','1d','3d','7d'] },
  status:          { type: String, default: 'active', enum: ['active','pending','sold','deleted','flagged'] },
  views:           { type: Number, default: 0 },
  saves:           { type: Number, default: 0 },
  ai_flagged:      { type: Boolean, default: false },
  ai_flag_reason:  { type: String, default: '' },
  ai_flag_category:{ type: String, default: '' },
  ai_flagged_at:   { type: Date, default: null },
  ai_reviewed:     { type: Boolean, default: false },
  expires_at:      { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

listingSchema.index({ category: 1 });
listingSchema.index({ status: 1 });
listingSchema.index({ seller_id: 1 });
listingSchema.index({ title: 'text', description: 'text' });

const waitlistSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

const hostelSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  campus: { type: String, default: 'Ajayi Crowther University' },
  is_active: { type: Boolean, default: true },
  sort_order: { type: Number, default: 0 },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

hostelSchema.index({ name: 1, campus: 1 }, { unique: true });

const savedListingSchema = new mongoose.Schema({
  user_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  listing_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

savedListingSchema.index({ user_id: 1, listing_id: 1 }, { unique: true });

// One document per (user, listing) in the cart — quantity is always 1 since every
// listing is a unique secondhand item, not stock. "How many" isn't meaningful here;
// "which items" is.
const cartItemSchema = new mongoose.Schema({
  user_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  listing_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

cartItemSchema.index({ user_id: 1, listing_id: 1 }, { unique: true });
cartItemSchema.index({ user_id: 1 });

const conversationSchema = new mongoose.Schema({
  listing_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', default: null },
  buyer_id:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  seller_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  last_message:    { type: String, default: null },
  last_message_at: { type: Date, default: Date.now },
  ai_flagged:      { type: Boolean, default: false },
  ai_flag_reason:  { type: String, default: '' },
  ai_flag_category:{ type: String, default: '' },
  ai_flagged_at:   { type: Date, default: null },
  ai_reviewed:     { type: Boolean, default: false },
  txn_status:      { type: String, enum: ['pending','completed','cancelled'], default: 'pending' },
  buyer_rated:     { type: Boolean, default: false },
  buyer_rating:    { type: Number, default: null, min: 1, max: 5 },
  buyer_review:    { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

conversationSchema.index({ buyer_id: 1 });
conversationSchema.index({ seller_id: 1 });

const messageSchema = new mongoose.Schema({
  conversation_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  sender_id:            { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver_id:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  listing_id:           { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', default: null },
  content:              { type: String, required: true },
  is_read:              { type: Boolean, default: false },
  is_admin_notification:{ type: Boolean, default: false },
  notification_to:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

messageSchema.index({ conversation_id: 1 });
messageSchema.index({ receiver_id: 1, is_read: 1 });

const conversationReportSchema = new mongoose.Schema({
  conversation_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  reporter_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reason:          { type: String, required: true, trim: true },
  status:          { type: String, enum: ['pending', 'resolved'], default: 'pending' },
  fault_user_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  admin_note:      { type: String, default: '' },
  resolved_at:     { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

conversationReportSchema.index({ conversation_id: 1 });
conversationReportSchema.index({ status: 1 });

// Reports submitted directly from a public user profile. Pending reports are
// reviewed by admins; only reports where an admin finds the target at fault
// affect seller discoverability.
const userReportSchema = new mongoose.Schema({
  reported_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reporter_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reason:           { type: String, required: true, trim: true },
  status:           { type: String, enum: ['pending', 'resolved', 'dismissed'], default: 'pending' },
  fault_confirmed:  { type: Boolean, default: false },
  admin_note:       { type: String, default: '' },
  resolved_at:      { type: Date, default: null },
  resolved_by:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

userReportSchema.index({ reported_user_id: 1, status: 1 });
userReportSchema.index({ reporter_id: 1, reported_user_id: 1, status: 1 });

const orderSchema = new mongoose.Schema({
  listing_id:             { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
  buyer_id:               { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  seller_id:              { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount:                 { type: Number, required: true },
  status:                 { type: String, default: 'pending', enum: ['pending','paid','confirmed','completing','fulfilled','completed','cancelled','disputed'] },
  delivery_code:          { type: String, default: null },
  delivery_code_expires_at:{ type: Date, default: null },
  platform_fee_percent:   { type: Number, default: 3 },
  platform_fee_amount:    { type: Number, default: 0 },
  seller_payout_amount:   { type: Number, default: 0 },
  processing_fee_amount:  { type: Number, default: 0 },
  seller_processing_fee_share: { type: Number, default: 0 },
  completed_at:           { type: Date, default: null },
  delivered_at:           { type: Date, default: null },
  meetup_location:        { type: String, default: null },
  meetup_time:            { type: String, default: null },
  buyer_marked_complete:  { type: Boolean, default: false },
  seller_marked_complete: { type: Boolean, default: false },
  buyer_rating:           { type: Number, default: null, min: 1, max: 5 },
  buyer_review:           { type: String, default: '' },
  buyer_rated_at:         { type: Date, default: null },
  seller_rating:          { type: Number, default: null, min: 1, max: 5 },
  seller_review:          { type: String, default: '' },
  seller_rated_at:        { type: Date, default: null },
  seller_accepted_at:     { type: Date, default: null },
  delivery_deadline_at:   { type: Date, default: null },
  response_deadline_at:   { type: Date, default: null },
  // Cart checkout fields. A cart with items from several sellers splits into one
  // Order per seller at checkout — checkout_group ties those siblings back together
  // as "one purchase" for the buyer's order history.
  checkout_group:         { type: String, default: null },
  fulfillment:            { type: String, enum: ['meetup', 'delivery'], default: 'meetup' },
  delivery_address:       { type: mongoose.Schema.Types.Mixed, default: null }, // { full_name, phone, address, campus, note }
  delivery_fee:           { type: Number, default: 0 },
  payment_method:         { type: String, enum: ['card'], default: 'card' },
  payment_status:         { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
  payment_reference:      { type: String, default: null },
  refund_status:          { type: String, enum: ['not_required', 'pending', 'processing', 'needs-attention', 'processed', 'failed'], default: 'not_required' },
  refund_amount:          { type: Number, default: 0 },
  refund_reference:       { type: String, default: null },
  refund_error:           { type: String, default: '' },
  refund_initiated_at:    { type: Date, default: null },
  refund_processed_at:    { type: Date, default: null },
  payout_status:          { type: String, default: 'pending', enum: ['pending','split','refunded','failed'] },
  payout_reference:       { type: String, default: null },
  payout_error:           { type: String, default: '' },
  dispute_reason:         { type: String, default: '' },
  dispute_status:         { type: String, default: 'none', enum: ['none','open','resolved'] },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

orderSchema.index({ buyer_id: 1 });
orderSchema.index({ seller_id: 1 });
orderSchema.index({ checkout_group: 1 });

// ── Admin broadcast messages ──
// Records each "send to selected users" action from the admin panel, for
// audit/history purposes. The actual delivery to each user lives in that
// user's own `admin_messages` array (see userSchema above).
const adminActionSchema = new mongoose.Schema({
  admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  admin_name: { type: String, default: '' },
  action: { type: String, required: true },
  target_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  target_user_name: { type: String, default: '' },
  target_user_email: { type: String, default: '' },
  reason: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });


const userActivitySchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  action: { type: String, required: true },
  method: { type: String, default: '' },
  path: { type: String, default: '' },
  status_code: { type: Number, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });
userActivitySchema.index({ user_id: 1, created_at: -1 });

const checkoutIntentSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true, index: true },
  buyer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  expected_total_kobo: { type: Number, required: true },
  delivery_address: { type: mongoose.Schema.Types.Mixed, default: null },
  items: { type: [mongoose.Schema.Types.Mixed], required: true },
  expires_at: { type: Date, required: true },
  used_at: { type: Date, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const broadcastSchema = new mongoose.Schema({
  title:            { type: String, default: '' },
  content:          { type: String, required: true },
  filters:          { type: mongoose.Schema.Types.Mixed, default: {} }, // filters used to build the recipient list, kept for audit history
  recipient_ids:    { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [] },
  recipient_count:  { type: Number, default: 0 },
  sent_by:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const User               = mongoose.model('User',               userSchema);
const Listing            = mongoose.model('Listing',            listingSchema);
const Waitlist           = mongoose.model('Waitlist',           waitlistSchema);
const Hostel             = mongoose.model('Hostel',             hostelSchema);
const SavedListing       = mongoose.model('SavedListing',       savedListingSchema);
const CartItem           = mongoose.model('CartItem',           cartItemSchema);
const Conversation       = mongoose.model('Conversation',       conversationSchema);
const Message            = mongoose.model('Message',            messageSchema);
const ConversationReport = mongoose.model('ConversationReport', conversationReportSchema);
const Order              = mongoose.model('Order',              orderSchema);
const Broadcast          = mongoose.model('Broadcast',          broadcastSchema);
const CheckoutIntent     = mongoose.model('CheckoutIntent',     checkoutIntentSchema);

const SELLER_COMMISSION_TIERS = [
  { level: 1, threshold: 0, commission_percent: 7.0, label: 'Starter', discount_cap: 0 },
  { level: 2, threshold: 10, commission_percent: 6.5, label: 'Trusted', discount_cap: 2 },
  { level: 3, threshold: 25, commission_percent: 6.0, label: 'Reliable', discount_cap: 4 },
  { level: 4, threshold: 50, commission_percent: 5.5, label: 'Top seller', discount_cap: 6 },
];

function getSellerCommissionInfo(successfulSalesCount = 0) {
  let selected = SELLER_COMMISSION_TIERS[0];
  let next = null;

  for (let i = 0; i < SELLER_COMMISSION_TIERS.length; i += 1) {
    const tier = SELLER_COMMISSION_TIERS[i];
    if (successfulSalesCount >= tier.threshold) {
      selected = tier;
      continue;
    }
    next = tier;
    break;
  }

  const salesSinceCurrent = Math.max(0, successfulSalesCount - selected.threshold);
  const remainingToNext = next ? Math.max(0, next.threshold - successfulSalesCount) : 0;
  const span = next ? Math.max(1, next.threshold - selected.threshold) : 1;
  const progressToNext = next ? Math.min(100, Math.max(0, (salesSinceCurrent / span) * 100)) : 100;

  return {
    level: selected.level,
    label: selected.label,
    commission_percent: Number(selected.commission_percent),
    discount_cap: selected.discount_cap,
    sales_count: Number(successfulSalesCount),
    next_tier: next ? next.level : null,
    next_tier_label: next ? next.label : null,
    next_threshold: next ? next.threshold : null,
    remaining_sales_to_next: remainingToNext,
    progress_to_next: Math.round(progressToNext),
  };
}

async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI environment variable is not set');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 45000 });
  console.log('  MongoDB connected:', mongoose.connection.host);
}

const AdminAction = mongoose.model('AdminAction', adminActionSchema);
const UserActivity = mongoose.model('UserActivity', userActivitySchema);
const UserReport = mongoose.model('UserReport', userReportSchema);

module.exports = {
  connectDb,
  User,
  Listing,
  Waitlist,
  Hostel,
  SavedListing,
  CartItem,
  Conversation,
  Message,
  ConversationReport,
  UserReport,
  Order,
  Broadcast,
  CheckoutIntent,
  AdminAction,
  UserActivity,
  SELLER_COMMISSION_TIERS,
  getSellerCommissionInfo,
};
