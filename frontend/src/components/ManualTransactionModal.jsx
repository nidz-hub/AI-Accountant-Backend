import { useState } from "react";


function ManualTransactionModal({
  onClose,
  onSaved,
}) {
  const [form, setForm] =
    useState({
      type: "sale",
      item: "",
      quantity: "",
      unit: "",
      pricePerUnit: "",
      totalAmount: "",
      counterparty: "",
      rawInput: "",
      date: new Date()
        .toISOString()
        .slice(0, 16),
    });


  const [saving, setSaving] =
    useState(false);

  const [error, setError] =
    useState("");


  function handleChange(event) {
    const {
      name,
      value,
    } = event.target;

    setForm((previous) => ({
      ...previous,
      [name]: value,
    }));
  }


  async function handleSubmit(
    event
  ) {
    event.preventDefault();

    setError("");


    if (!form.item.trim()) {
      setError(
        "Please enter an item."
      );
      return;
    }


    if (
      !form.quantity ||
      Number(form.quantity) <= 0
    ) {
      setError(
        "Please enter a valid quantity."
      );
      return;
    }


    if (
      form.pricePerUnit === "" ||
      Number(form.pricePerUnit) < 0
    ) {
      setError(
        "Please enter a valid price."
      );
      return;
    }


    if (
      form.totalAmount === "" ||
      Number(form.totalAmount) < 0
    ) {
      setError(
        "Please enter the total amount."
      );
      return;
    }


    setSaving(true);


    try {
      const transaction = {
        date: new Date(
          form.date
        ).toISOString(),

        type: form.type,

        item:
          form.item.trim(),

        quantity:
          Number(form.quantity),

        unit:
          form.unit.trim() ||
          "unit",

        pricePerUnit:
          Number(
            form.pricePerUnit
          ),

        totalAmount:
          Number(
            form.totalAmount
          ),

        currency: "INR",

        counterparty:
          form.counterparty.trim() ||
          null,

        source: "manual",

        rawInput:
          form.rawInput.trim(),

        confidence: 1,
      };


      await onSaved(
        transaction
      );
    } catch (err) {
      console.error(err);

      setError(
        err.message ||
          "Unable to save transaction."
      );
    } finally {
      setSaving(false);
    }
  }


  return (
    <div className="modal-overlay">

      <div className="manual-modal">

        <div className="modal-glow" />

        <div className="manual-modal-header">

          <div>

            <div className="modal-kicker">
              MANUAL CAPTURE
            </div>

            <h2>
              Add a transaction
            </h2>

            <p>
              Record what happened in
              your business.
            </p>

          </div>


          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            disabled={saving}
          >
            ×
          </button>

        </div>


        <form
          onSubmit={handleSubmit}
        >

          <div className="form-group">

            <label>
              What happened?
            </label>

            <textarea
              name="rawInput"
              value={
                form.rawInput
              }
              onChange={
                handleChange
              }
              placeholder="Example: Sold 2kg onions to Ramu for ₹80"
              rows="3"
            />

            <span className="field-help">
              Optional — keep the original
              description for your records.
            </span>

          </div>


          <div className="form-group">

            <label>
              Transaction type
            </label>

            <div className="type-options">

              <button
                type="button"
                className={
                  form.type === "sale"
                    ? "type-option active"
                    : "type-option"
                }
                onClick={() =>
                  setForm({
                    ...form,
                    type: "sale",
                  })
                }
              >
                <span>↗</span>
                Sale
              </button>


              <button
                type="button"
                className={
                  form.type ===
                  "purchase"
                    ? "type-option active"
                    : "type-option"
                }
                onClick={() =>
                  setForm({
                    ...form,
                    type: "purchase",
                  })
                }
              >
                <span>↓</span>
                Purchase
              </button>


              <button
                type="button"
                className={
                  form.type ===
                  "expense"
                    ? "type-option active"
                    : "type-option"
                }
                onClick={() =>
                  setForm({
                    ...form,
                    type: "expense",
                  })
                }
              >
                <span>−</span>
                Expense
              </button>

            </div>

          </div>


          <div className="form-group">

            <label htmlFor="item">
              Item
            </label>

            <input
              id="item"
              name="item"
              type="text"
              placeholder="e.g. Onions"
              value={
                form.item
              }
              onChange={
                handleChange
              }
            />

          </div>


          <div className="form-row">

            <div className="form-group">

              <label htmlFor="quantity">
                Quantity
              </label>

              <input
                id="quantity"
                name="quantity"
                type="number"
                min="0"
                step="any"
                placeholder="2"
                value={
                  form.quantity
                }
                onChange={
                  handleChange
                }
              />

            </div>


            <div className="form-group">

              <label htmlFor="unit">
                Unit
              </label>

              <input
                id="unit"
                name="unit"
                type="text"
                placeholder="kg"
                value={
                  form.unit
                }
                onChange={
                  handleChange
                }
              />

            </div>

          </div>


          <div className="form-row">

            <div className="form-group">

              <label htmlFor="pricePerUnit">
                Price per unit
              </label>

              <div className="input-with-symbol">

                <span>₹</span>

                <input
                  id="pricePerUnit"
                  name="pricePerUnit"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="40"
                  value={
                    form.pricePerUnit
                  }
                  onChange={
                    handleChange
                  }
                />

              </div>

            </div>


            <div className="form-group">

              <label htmlFor="totalAmount">
                Total amount
              </label>

              <div className="input-with-symbol">

                <span>₹</span>

                <input
                  id="totalAmount"
                  name="totalAmount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="80"
                  value={
                    form.totalAmount
                  }
                  onChange={
                    handleChange
                  }
                />

              </div>

            </div>

          </div>


          <div className="form-group">

            <label htmlFor="counterparty">
              Customer / Supplier
            </label>

            <input
              id="counterparty"
              name="counterparty"
              type="text"
              placeholder="e.g. Ramu"
              value={
                form.counterparty
              }
              onChange={
                handleChange
              }
            />

          </div>


          <div className="form-group">

            <label htmlFor="date">
              Date & time
            </label>

            <input
              id="date"
              name="date"
              type="datetime-local"
              value={
                form.date
              }
              onChange={
                handleChange
              }
            />

          </div>


          {error && (
            <div className="form-error">
              {error}
            </div>
          )}


          <div className="modal-actions">

            <button
              type="button"
              className="cancel-button"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>


            <button
              type="submit"
              className="save-button"
              disabled={saving}
            >
              {saving
                ? "Saving..."
                : "Save transaction"}
            </button>

          </div>

        </form>

      </div>

    </div>
  );
}


export default ManualTransactionModal;