import {

  useEffect,

  useRef,

  useState,

} from "react";



import {

  getSummary,

  getTransactions,

  getCreditReadiness,

  getUploadUrl,

  uploadFileToS3,

  processPhoto,

  processVoice,

  createTransaction,

} from "./services/api";



import ManualTransactionModal from "./components/ManualTransactionModal";



import "./App.css";





function formatCurrency(value) {

  return `₹${Number(

    value || 0

  ).toLocaleString("en-IN")}`;

}





function formatDate(value) {

  if (!value) {

    return "—";

  }



  return new Date(value).toLocaleDateString(

    "en-IN",

    {

      day: "numeric",

      month: "short",

      year: "numeric",

    }

  );

}





function percentage(value, fallback = 0) {

  const number = Number(value);



  if (!Number.isFinite(number)) {

    return fallback;

  }



  return Math.max(

    0,

    Math.min(

      100,

      Math.round(

        number <= 1

          ? number * 100

          : number

      )

    )

  );

}





function App() {

  const fileInputRef = useRef(null);
  const recognitionRef = useRef(null);

  const timerRef = useRef(null);



  const dashboardRef = useRef(null);

  const captureRef = useRef(null);

  const transactionsRef = useRef(null);

  const reportsRef = useRef(null);

  const readinessRef = useRef(null);



  const [darkMode, setDarkMode] = useState(() => {

    const saved =

      localStorage.getItem(

        "STACKR-theme"

      );



    if (saved) {

      return saved === "dark";

    }



    return window.matchMedia(

      "(prefers-color-scheme: dark)"

    ).matches;

  });



  const [summary, setSummary] = useState(null);

  const [transactions, setTransactions] = useState([]);

  const [readiness, setReadiness] = useState(null);



  const [loading, setLoading] = useState(true);

  const [error, setError] = useState("");



  const [processingPhoto, setProcessingPhoto] =

    useState(false);



  const [photoError, setPhotoError] =

    useState("");



  const [voiceRecording, setVoiceRecording] =

    useState(false);



  const [processingVoice, setProcessingVoice] =

    useState(false);



  const [voiceError, setVoiceError] =

    useState("");



  const [voiceSeconds, setVoiceSeconds] =

    useState(0);



  const [aiResult, setAiResult] = useState(null);

  const [aiSource, setAiSource] = useState("");

  const [savingAI, setSavingAI] = useState(false);

  const [aiError, setAiError] = useState("");



  const [manualOpen, setManualOpen] =

    useState(false);



  const [readinessOpen, setReadinessOpen] =

    useState(false);





  useEffect(() => {

    document.documentElement.dataset.theme =

      darkMode ? "dark" : "light";



    localStorage.setItem(

      "STACKR-theme",

      darkMode ? "dark" : "light"

    );

  }, [darkMode]);





  async function loadData() {

    try {

      setLoading(true);

      setError("");



      const [

        summaryData,

        transactionData,

        readinessData,

      ] = await Promise.all([

        getSummary(),

        getTransactions(),

        getCreditReadiness(),

      ]);



      setSummary(summaryData);



      setTransactions(

        transactionData.transactions || []

      );



      setReadiness(readinessData);

    } catch (err) {

      console.error(err);



      setError(

        err.message ||

          "Unable to load your business data."

      );

    } finally {

      setLoading(false);

    }

  }





  useEffect(() => {

    loadData();



    return () => {

      if (timerRef.current) {

        clearInterval(timerRef.current);

      }



      if (recognitionRef.current) {

        try {

          recognitionRef.current.stop();

        } catch {

          // Recognition may already be stopped.

        }

      }

    };

  }, []);





  function scrollTo(ref) {

    ref.current?.scrollIntoView({

      behavior: "smooth",

      block: "start",

    });

  }





  function openCapture() {

    scrollTo(captureRef);

  }





  function openManual() {

    setManualOpen(true);

  }





  function convertImageToJpeg(file) {

    return new Promise(

      (resolve, reject) => {

        const image = new Image();



        const url =

          URL.createObjectURL(file);



        image.onload = () => {

          const canvas =

            document.createElement(

              "canvas"

            );



          canvas.width =

            image.naturalWidth;



          canvas.height =

            image.naturalHeight;



          const context =

            canvas.getContext("2d");



          if (!context) {

            URL.revokeObjectURL(url);



            reject(

              new Error(

                "Unable to prepare image."

              )

            );



            return;

          }



          context.drawImage(

            image,

            0,

            0

          );



          canvas.toBlob(

            (blob) => {

              URL.revokeObjectURL(url);



              if (!blob) {

                reject(

                  new Error(

                    "Unable to convert image."

                  )

                );



                return;

              }



              resolve(

                new File(

                  [blob],

                  `${file.name.replace(

                    /\\.[^/.]+$/,

                    ""

                  )}.jpg`,

                  {

                    type: "image/jpeg",

                  }

                )

              );

            },

            "image/jpeg",

            0.9

          );

        };



        image.onerror = () => {

          URL.revokeObjectURL(url);



          reject(

            new Error(

              "Unable to read image."

            )

          );

        };



        image.src = url;

      }

    );

  }





  async function handlePhoto(event) {

    const file =

      event.target.files?.[0];



    if (!file) {

      return;

    }



    setPhotoError("");

    setAiError("");

    setAiResult(null);



    try {

      setProcessingPhoto(true);



      const jpeg =

        await convertImageToJpeg(file);



      const upload =

        await getUploadUrl(

          "image/jpeg"

        );



      await uploadFileToS3(

        upload.uploadUrl,

        jpeg

      );



      const result =

        await processPhoto(

          upload.s3Key

        );



      if (

        !result.transactions?.length

      ) {

        throw new Error(

          "No transaction could be detected in this bill."

        );

      }



      setAiSource("photo");

      setAiResult(result);

    } catch (err) {

      console.error(err);



      setPhotoError(

        err.message ||

          "Unable to process this bill."

      );

    } finally {

      setProcessingPhoto(false);



      if (fileInputRef.current) {

        fileInputRef.current.value =

          "";

      }

    }

  }





  function startVoice() {

    setVoiceError("");

    setAiError("");



    const SpeechRecognition =

      window.SpeechRecognition ||

      window.webkitSpeechRecognition;



    if (!SpeechRecognition) {

      setVoiceError(

        "Voice recognition is not supported in this browser. Please use Google Chrome."

      );



      return;

    }



    setVoiceRecording(true);

    setVoiceSeconds(0);

    setVoiceError("");



    const recognition = new SpeechRecognition();



    recognitionRef.current = recognition;



    recognition.lang = "en-IN";

    recognition.continuous = false;

    recognition.interimResults = false;

    recognition.maxAlternatives = 1;



    recognition.onstart = () => {

      setVoiceRecording(true);



      timerRef.current =

        setInterval(() => {

          setVoiceSeconds(

            (value) => value + 1

          );

        }, 1000);

    };



    recognition.onresult = async (event) => {

      const transcript =

        event.results?.[0]?.[0]?.transcript?.trim();



      if (!transcript) {

        setVoiceRecording(false);

        setVoiceError(

          "I didn't hear anything. Please try again."

        );

        return;

      }



      setVoiceRecording(false);



      if (timerRef.current) {

        clearInterval(timerRef.current);

        timerRef.current = null;

      }



      try {

        setProcessingVoice(true);

        setVoiceError("");



        const result =

          await processVoice(transcript);



        if (!result.transactions?.length) {

          throw new Error(

            "No transaction could be identified from the recording."

          );

        }



        setAiSource("voice");

        setAiResult(result);

      } catch (err) {

        console.error(err);



        setVoiceError(

          err.message ||

            "Unable to process voice recording."

        );

      } finally {

        setProcessingVoice(false);

      }

    };



    recognition.onerror = (event) => {

      console.error(

        "Speech recognition error:",

        event.error

      );



      setVoiceRecording(false);



      if (timerRef.current) {

        clearInterval(timerRef.current);

        timerRef.current = null;

      }



      if (event.error === "not-allowed") {

        setVoiceError(

          "Microphone access was blocked. Please allow microphone access in Chrome and try again."

        );

      } else if (event.error === "no-speech") {

        setVoiceError(

          "I didn't hear anything. Please try speaking again."

        );

      } else {

        setVoiceError(

          "Voice recognition failed. Please try again."

        );

      }

    };



    recognition.onend = () => {

      setVoiceRecording(false);



      if (timerRef.current) {

        clearInterval(timerRef.current);

        timerRef.current = null;

      }

    };



    try {

      recognition.start();

    } catch (err) {

      console.error(err);



      setVoiceRecording(false);



      if (timerRef.current) {

        clearInterval(timerRef.current);

        timerRef.current = null;

      }



      setVoiceError(

        "Unable to start voice recognition. Please try again."

      );

    }

  }





  function stopVoice() {

    if (timerRef.current) {

      clearInterval(timerRef.current);

      timerRef.current = null;

    }



    setVoiceRecording(false);



    if (recognitionRef.current) {

      try {

        recognitionRef.current.stop();

      } catch {

        // Recognition may already be stopped.

      }

    }

  }





  async function handleManualSaved(

    transaction

  ) {

    await createTransaction(

      transaction

    );



    setManualOpen(false);



    await loadData();

  }





  async function saveAI(transaction) {

    try {

      setSavingAI(true);

      setAiError("");



      await createTransaction({

        ...transaction,

        source:

          transaction.source ||

          aiSource,

        rawInput:

          transaction.rawInput ||

          aiResult?.transcript ||

          "",

        confidence:

          Number(

            transaction.confidence

          ) || 0,

        quantity:

          Number(

            transaction.quantity

          ) || 0,

        pricePerUnit:

          Number(

            transaction.pricePerUnit

          ) || 0,

        totalAmount:

          Number(

            transaction.totalAmount

          ) || 0,

        currency:

          transaction.currency ||

          "INR",

      });



      setAiResult(null);

      await loadData();

    } catch (err) {

      console.error(err);



      setAiError(

        err.message ||

          "Unable to save transaction."

      );

    } finally {

      setSavingAI(false);

    }

  }





  const sales =

    Number(

      summary?.totalSales || 0

    );



  const expenses =

    Number(

      summary?.totalExpenses || 0

    );



  const profit =

    Number(

      summary?.netProfit || 0

    );



  const count =

    Number(

      summary?.transactionCount || 0

    );





  const readinessScore =

    Number(

      readiness?.score || 0

    );



  const completeness =

    percentage(

      readiness?.recordCompleteness,

      readinessScore

    );





  const recent =

    transactions.slice(0, 6);





  return (

    <div

      className={

        darkMode

          ? "app dark"

          : "app"

      }

    >



      {/* SIDEBAR */}



      <aside className="sidebar">



        <div className="brand">



          <div className="brand-logo">

            <span>₹</span>

          </div>



          <div>

            <strong>

              STACKR

            </strong>



            <small>

              AI Accountant

            </small>

          </div>



        </div>





        <div className="sidebar-label">

          WORKSPACE

        </div>





        <nav className="nav">



          <button

            className="nav-link active"

            onClick={() =>

              scrollTo(

                dashboardRef

              )

            }

          >

            <span>⌂</span>

            Overview

          </button>





          <button

            className="nav-link"

            onClick={() =>

              scrollTo(

                transactionsRef

              )

            }

          >

            <span>↕</span>

            Transactions

          </button>





          <button

            className="nav-link"

            onClick={() =>

              scrollTo(

                reportsRef

              )

            }

          >

            <span>◔</span>

            Reports

          </button>





          <button

            className="nav-link"

            onClick={() =>

              scrollTo(

                readinessRef

              )

            }

          >

            <span>✦</span>

            Credit readiness

          </button>



        </nav>





        <div className="sidebar-bottom">



          <div className="sidebar-tip">



            <div className="tip-icon">

              ✨

            </div>



            <div>

              <strong>

                AI bookkeeping

              </strong>



              <span>

                Let STACKR handle the

                boring part.

              </span>

            </div>



          </div>





          <div className="profile">



            <div className="profile-avatar">

              K

            </div>



            <div>

              <strong>

                Kirana Store

              </strong>



              <span>

                Demo account

              </span>

            </div>



          </div>



        </div>



      </aside>





      {/* MAIN */}



      <main

        className="content"

        ref={dashboardRef}

      >



        <header className="header">



          <div>



            <span className="page-kicker">

              BUSINESS WORKSPACE

            </span>



            <h1>

              Good morning, Kirana Store

              <span className="wave">

                👋

              </span>

            </h1>



            <p>

              Everything important about

              your business, in one place.

            </p>



          </div>





          <div className="header-actions">



            <button

              className="theme-toggle"

              onClick={() =>

                setDarkMode(

                  (value) => !value

                )

              }

              title={

                darkMode

                  ? "Switch to light mode"

                  : "Switch to dark mode"

              }

            >

              {darkMode

                ? "☀"

                : "☾"}

            </button>





            <button

              className="capture-button"

              onClick={openCapture}

            >

              <span>＋</span>

              Capture

            </button>





            <div className="header-avatar">

              K

            </div>



          </div>



        </header>





        {error && (

          <div className="error-banner">

            <span>

              {error}

            </span>



            <button

              onClick={loadData}

            >

              Retry

            </button>

          </div>

        )}





        {/* HERO */}



        <section className="hero">



          <div className="hero-content">



            <div className="hero-pill">

              <span />

              AI-POWERED BOOKKEEPING

            </div>



            <h2>

              Your business.

              <br />

              <em>

                Finally organized.

              </em>

            </h2>



            <p>

              Photograph a bill, speak a

              transaction, or enter it yourself.

              STACKR turns everyday business

              activity into clean financial records.

            </p>





            <div className="hero-actions">



              <button

                className="hero-primary"

                onClick={openCapture}

              >

                Start capturing

                <span>→</span>

              </button>



              <button

                className="hero-secondary"

                onClick={() =>

                  scrollTo(

                    readinessRef

                  )

                }

              >

                Check credit readiness

              </button>



            </div>





            <div className="hero-mini-stats">



              <div>

                <strong>

                  {count}

                </strong>



                <span>

                  records

                </span>

              </div>





              <div className="mini-divider" />





              <div>

                <strong>

                  {formatCurrency(

                    sales

                  )}

                </strong>



                <span>

                  sales tracked

                </span>

              </div>





              <div className="mini-divider" />





              <div>

                <strong>

                  {completeness}%

                </strong>



                <span>

                  record completeness

                </span>

              </div>



            </div>



          </div>





          <div className="hero-visual">



            <div className="orb orb-one" />

            <div className="orb orb-two" />





            <div className="floating-card card-main">



              <div className="card-main-top">



                <span>

                  BUSINESS PULSE

                </span>



                <span className="live-dot">

                  ● LIVE

                </span>



              </div>



              <div className="pulse-number">

                {formatCurrency(

                  sales

                )}

              </div>



              <div className="pulse-label">

                total sales

              </div>





              <div className="fake-chart">



                <span

                  style={{

                    height: "30%",

                  }}

                />



                <span

                  style={{

                    height: "46%",

                  }}

                />



                <span

                  style={{

                    height: "38%",

                  }}

                />



                <span

                  style={{

                    height: "65%",

                  }}

                />



                <span

                  style={{

                    height: "54%",

                  }}

                />



                <span

                  style={{

                    height: "82%",

                  }}

                />



                <span

                  style={{

                    height: "73%",

                  }}

                />



                <span

                  style={{

                    height: "94%",

                  }}

                />



              </div>



            </div>





            <div className="floating-card card-small">



              <span>

                Net profit

              </span>



              <strong>

                {formatCurrency(

                  profit

                )}

              </strong>



              <small>

                this period

              </small>



            </div>





            <div className="floating-card card-ai">



              <div className="ai-spark">

                ✦

              </div>



              <div>

                <strong>

                  AI ready

                </strong>



                <span>

                  Your books are up to date

                </span>

              </div>



            </div>



          </div>



        </section>





        {/* CAPTURE */}



        <section

          className="capture-section"

          ref={captureRef}

        >



          <div className="section-top">



            <div>



              <span className="section-kicker">

                QUICK CAPTURE

              </span>



              <h2>

                How do you want to record it?

              </h2>



              <p>

                Pick whichever feels easiest.

              </p>



            </div>



            <span className="section-note">

              3 ways to capture

            </span>



          </div>





          <div className="capture-grid">



            <button

              className="capture-card photo-card"

              onClick={() =>

                fileInputRef.current?.click()

              }

              disabled={

                processingPhoto

              }

            >



              <div className="capture-card-top">



                <div className="capture-symbol">

                  {processingPhoto

                    ? "..."

                    : "▣"}

                </div>



                <span>

                  01

                </span>



              </div>





              <div className="capture-card-content">



                <h3>

                  Photograph a bill

                </h3>



                <p>

                  Point your camera at a

                  paper bill and let AI read it.

                </p>



              </div>





              <div className="capture-card-footer">



                <span>

                  {processingPhoto

                    ? "Processing..."

                    : "Upload image"}

                </span>



                <b>

                  →

                </b>



              </div>



            </button>





            <button

              className={`capture-card voice-card ${

                voiceRecording

                  ? "recording"

                  : ""

              }`}

              onClick={

                voiceRecording

                  ? stopVoice

                  : startVoice

              }

              disabled={

                processingVoice

              }

            >



              <div className="capture-card-top">



                <div className="capture-symbol">

                  {processingVoice

                    ? "..."

                    : voiceRecording

                    ? "■"

                    : "◉"}

                </div>



                <span>

                  02

                </span>



              </div>





              <div className="capture-card-content">



                <h3>

                  Voice Record

                </h3>



                <p>

                  Speak naturally. For example:

                  “Sold 2kg onions to Ramu.”

                </p>



              </div>





              <div className="capture-card-footer">



                <span>

                  {voiceRecording

                    ? `Recording ${voiceSeconds}s`

                    : processingVoice

                    ? "Processing..."

                    : "Start recording"}

                </span>



                <b>

                  →

                </b>



              </div>



            </button>





            <button

              className="capture-card manual-card"

              onClick={openManual}

            >



              <div className="capture-card-top">



                <div className="capture-symbol">

                  ✎

                </div>



                <span>

                  03

                </span>



              </div>





              <div className="capture-card-content">



                <h3>

                  Enter manually

                </h3>



                <p>

                  Have the details already?

                  Enter them directly.

                </p>



              </div>





              <div className="capture-card-footer">



                <span>

                  Open entry form

                </span>



                <b>

                  →

                </b>



              </div>



            </button>



          </div>





          <input

            ref={fileInputRef}

            type="file"

            accept="image/*"

            onChange={handlePhoto}

            hidden

          />





          {photoError && (

            <div className="inline-error">

              {photoError}

            </div>

          )}





          {voiceError && (

            <div className="inline-error">

              {voiceError}

            </div>

          )}



        </section>





        {/* FINANCIAL SNAPSHOT */}



        <section

          className="numbers-section"

          ref={reportsRef}

        >



          <div className="section-top">



            <div>



              <span className="section-kicker">

                FINANCIAL SNAPSHOT

              </span>



              <h2>

                Know your numbers.

              </h2>



            </div>



            <span className="section-note">

              Based on recorded activity

            </span>



          </div>





          <div className="numbers-grid">



            <div className="number-card sales">



              <div className="number-icon">

                ↗

              </div>



              <span>

                TOTAL SALES

              </span>



              <strong>

                {formatCurrency(

                  sales

                )}

              </strong>



              <small>

                Money coming in

              </small>



            </div>





            <div className="number-card expenses">



              <div className="number-icon">

                −

              </div>



              <span>

                TOTAL EXPENSES

              </span>



              <strong>

                {formatCurrency(

                  expenses

                )}

              </strong>



              <small>

                Money going out

              </small>



            </div>





            <div className="number-card profit">



              <div className="number-icon">

                ₹

              </div>



              <span>

                NET PROFIT

              </span>



              <strong>

                {formatCurrency(

                  profit

                )}

              </strong>



              <small>

                Sales minus expenses

              </small>



            </div>





            <div className="number-card records">



              <div className="number-icon">

                #

              </div>



              <span>

                RECORDS

              </span>



              <strong>

                {count}

              </strong>



              <small>

                Transactions captured

              </small>



            </div>



          </div>



        </section>





        {/* TRANSACTIONS */}



        <section

          className="activity-section"

          ref={transactionsRef}

        >



          <div className="section-top">



            <div>



              <span className="section-kicker">

                RECENT ACTIVITY

              </span>



              <h2>

                What's happening?

              </h2>



            </div>



            <button

              className="section-link"

              onClick={() =>

                scrollTo(

                  transactionsRef

                )

              }

            >

              All activity →

            </button>



          </div>





          <div className="activity-panel">



            {loading ? (



              <div className="empty">

                Loading your records...

              </div>



            ) : recent.length === 0 ? (



              <div className="empty">



                <div className="empty-symbol">

                  ✦

                </div>



                <strong>

                  Your activity will appear here

                </strong>



                <span>

                  Capture your first transaction

                  to get started.

                </span>



              </div>



            ) : (



              recent.map(

                (transaction) => (



                  <div

                    className="activity-row"

                    key={

                      transaction.transactionId

                    }

                  >



                    <div className="activity-left">



                      <div

                        className={`activity-type ${

                          transaction.type

                        }`}

                      >

                        {transaction.type ===

                        "sale"

                          ? "↗"

                          : transaction.type ===

                            "purchase"

                          ? "↓"

                          : "−"}

                      </div>



                      <div>



                        <strong>

                          {transaction.item ||

                            "Transaction"}

                        </strong>



                        <span>

                          {transaction.quantity}{" "}

                          {transaction.unit ||

                            "unit"}



                          {transaction.counterparty

                            ? ` · ${transaction.counterparty}`

                            : ""}

                        </span>



                      </div>



                    </div>





                    <div className="activity-right">



                      <strong>

                        {formatCurrency(

                          transaction.totalAmount

                        )}

                      </strong>



                      <span>

                        {formatDate(

                          transaction.date

                        )}

                      </span>



                    </div>



                  </div>



                )

              )



            )}



          </div>



        </section>





        {/* CREDIT READINESS */}



        <section

          className="readiness-section"

          ref={readinessRef}

        >



          <div className="credit-header">



            <div>



              <span className="section-kicker">

                CREDIT READINESS

              </span>



              <h2>

                Understand how prepared

                your business records are.

              </h2>



              <p>

                STACKR looks at the quality,

                completeness and consistency of

                your recorded business activity.

              </p>



            </div>



          </div>





          <div className="credit-readiness-card">



            <div className="credit-readiness-main">



              <div className="credit-score-area">



                <div

                  className="credit-meter"

                  style={{

                    "--progress":

                      `${completeness}%`,

                  }}

                >



                  <div className="credit-meter-inner">



                    <strong>

                      {readinessScore}

                    </strong>



                    <span>

                      /100

                    </span>



                  </div>



                </div>





                <div className="credit-score-copy">



                  <span className="credit-score-label">

                    CREDIT READINESS SCORE

                  </span>



                  <h3>

                    {readinessScore >= 80

                      ? "Strong record foundation"

                      : readinessScore >= 60

                      ? "Good foundation — keep building"

                      : readinessScore >= 40

                      ? "More records would help"

                      : "Start building your record"}

                  </h3>



                  <p>

                    This is a <strong>record-readiness

                    score</strong>, not a credit score.

                    It shows how prepared your financial

                    records are for a formal financing

                    application.

                  </p>



                </div>



              </div>





              <div className="credit-explanation">



                <div className="explanation-item">



                  <span className="explanation-icon">

                    ✓

                  </span>



                  <div>



                    <strong>

                      What this score measures

                    </strong>



                    <p>

                      How complete and organized

                      your business transaction

                      history is.

                    </p>



                  </div>



                </div>





                <div className="explanation-item">



                  <span className="explanation-icon">

                    ↗

                  </span>



                  <div>



                    <strong>

                      Why it matters

                    </strong>



                    <p>

                      Well-maintained records can

                      make it easier to demonstrate

                      your business activity when

                      preparing financial documents.

                    </p>



                  </div>



                </div>





                <div className="explanation-item">



                  <span className="explanation-icon">

                    ✦

                  </span>



                  <div>



                    <strong>

                      What it does not mean

                    </strong>



                    <p>

                      This number does not determine

                      your creditworthiness, loan

                      approval, interest rate or

                      eligibility.

                    </p>



                  </div>



                </div>



              </div>



            </div>





            <div className="credit-metrics">



              <div className="credit-metric">



                <span>

                  RECORD COMPLETENESS

                </span>



                <strong>

                  {completeness}%

                </strong>



                <div className="metric-bar">

                  <div

                    style={{

                      width:

                        `${completeness}%`,

                    }}

                  />

                </div>



                <p>

                  How complete your recorded

                  business information is.

                </p>



              </div>





              <div className="credit-metric">



                <span>

                  RECORD HISTORY

                </span>



                <strong>

                  {readiness?.monthsOfRecords ??

                    "—"}{" "}

                  months

                </strong>



                <p>

                  Length of business activity

                  currently represented in your

                  records.

                </p>



              </div>





              <div className="credit-metric">



                <span>

                  TRANSACTIONS

                </span>



                <strong>

                  {count}

                </strong>



                <p>

                  Transactions currently captured

                  in STACKR.

                </p>



              </div>



            </div>





            <div className="credit-next-step">



              <div>



                <span className="section-kicker">

                  NEXT STEP

                </span>



                <h3>

                  Keep strengthening your records.

                </h3>



                <p>

                  Regularly record sales, purchases

                  and expenses. Complete missing

                  transaction details and keep your

                  records consistent over time.

                </p>



              </div>





              <button

                className="readiness-button"

                onClick={() =>

                  setReadinessOpen(

                    (value) => !value

                  )

                }

              >

                {readinessOpen

                  ? "Hide checklist ↑"

                  : "See detailed checklist →"}

              </button>



            </div>



          </div>





          {readinessOpen && (

            <div className="readiness-details">



              <div className="readiness-stat">



                <span>

                  MONTHS OF RECORDS

                </span>



                <strong>

                  {readiness?.monthsOfRecords ??

                    "—"}

                </strong>



                <p>

                  More historical records give

                  you a clearer picture of your

                  business activity.

                </p>



              </div>





              <div className="readiness-stat">



                <span>

                  COMPLETENESS

                </span>



                <strong>

                  {completeness}%

                </strong>



                <p>

                  Aim to capture important details

                  for every transaction.

                </p>



              </div>





              <div className="readiness-stat">



                <span>

                  TRANSACTIONS

                </span>



                <strong>

                  {count}

                </strong>



                <p>

                  Keep recording everyday sales,

                  purchases and expenses.

                </p>



              </div>





              {readiness?.narrative && (

                <div className="readiness-narrative">



                  <span>

                    YOUR RECORD SUMMARY

                  </span>



                  <p>

                    {readiness.narrative}

                  </p>



                </div>

              )}





              <div className="readiness-guidance">



                <div className="guidance-title">

                  How to improve your record readiness

                </div>





                <div className="guidance-grid">



                  <div>

                    <strong>

                      01 · Record regularly

                    </strong>



                    <p>

                      Capture transactions as they

                      happen instead of letting them

                      accumulate.

                    </p>

                  </div>





                  <div>

                    <strong>

                      02 · Complete the details

                    </strong>



                    <p>

                      Include dates, amounts, items,

                      quantities and counterparties

                      whenever possible.

                    </p>

                  </div>





                  <div>

                    <strong>

                      03 · Keep the history growing

                    </strong>



                    <p>

                      Continue maintaining records

                      month after month.

                    </p>

                  </div>





                  <div>

                    <strong>

                      04 · Review before applying

                    </strong>



                    <p>

                      Check your records and correct

                      missing or incorrect information

                      before preparing financial documents.

                    </p>

                  </div>



                </div>



              </div>





              {Array.isArray(

                readiness?.checklist

              ) &&

                readiness.checklist.length > 0 && (

                  <div className="readiness-checklist">



                    <span>

                      YOUR CHECKLIST

                    </span>



                    {readiness.checklist.map(

                      (item, index) => {



                        const object =

                          item &&

                          typeof item ===

                            "object";



                        const label =

                          object

                            ? item.label ||

                              item.name ||

                              item.title ||

                              `Item ${index + 1}`

                            : String(

                                item

                              );



                        const complete =

                          object

                            ? Boolean(

                                item.completed ??

                                  item.complete ??

                                  item.done

                              )

                            : false;



                        return (

                          <div

                            key={index}

                            className="check-item"

                          >



                            <span

                              className={

                                complete

                                  ? "check complete"

                                  : "check"

                              }

                            >

                              {complete

                                ? "✓"

                                : "•"}

                            </span>



                            <span>

                              {label}

                            </span>



                          </div>

                        );

                      }

                    )}



                  </div>

                )}



            </div>

          )}



        </section>





        <footer className="footer">



          <span>

            STACKR

          </span>



          <span>

            AI-powered bookkeeping for

            everyday businesses.

          </span>



        </footer>



      </main>





      {manualOpen && (

        <ManualTransactionModal

          onClose={() =>

            setManualOpen(false)

          }

          onSaved={

            handleManualSaved

          }

        />

      )}





      {aiResult && (

        <AIReviewModal

          result={aiResult}

          source={aiSource}

          saving={savingAI}

          error={aiError}

          onClose={() => {

            if (!savingAI) {

              setAiResult(null);

              setAiSource("");

            }

          }}

          onSave={saveAI}

        />

      )}



    </div>

  );

}





/* ========================================

   AI REVIEW MODAL

======================================== */



function AIReviewModal({

  result,

  source,

  saving,

  error,

  onClose,

  onSave,

}) {

  const [

    transaction,

    setTransaction,

  ] = useState(

    result.transactions?.[0] ||

      {}

  );





  useEffect(() => {

    setTransaction(

      result.transactions?.[0] ||

        {}

    );

  }, [result]);





  function update(field, value) {

    setTransaction(

      (previous) => ({

        ...previous,

        [field]: value,

      })

    );

  }





  function save() {

    if (

      !transaction.item?.trim()

    ) {

      return;

    }



    onSave({

      ...transaction,



      item:

        transaction.item.trim(),



      quantity:

        Number(

          transaction.quantity

        ) || 0,



      pricePerUnit:

        Number(

          transaction.pricePerUnit

        ) || 0,



      totalAmount:

        Number(

          transaction.totalAmount

        ) || 0,



      currency:

        transaction.currency ||

        "INR",



      source:

        transaction.source ||

        source,



      rawInput:

        transaction.rawInput ||

        result.transcript ||

        "",



      date:

        transaction.date ||

        new Date().toISOString(),

    });

  }





  return (

    <div className="modal-overlay">



      <div className="ai-modal">



        <div className="manual-modal-header">



          <div>



            <div className="modal-kicker">

              AI REVIEW

            </div>



            <h2>

              Check what AI found

            </h2>



            <p>

              Review the details before

              saving them to your books.

            </p>



          </div>





          <button

            className="modal-close"

            onClick={onClose}

            disabled={saving}

          >

            ×

          </button>



        </div>





        {result.transcript && (

          <div className="transcript">



            <span>

              TRANSCRIPT

            </span>



            <p>

              {result.transcript}

            </p>



          </div>

        )}





        <div className="review-confidence">



          <span>

            AI confidence

          </span>



          <strong>

            {Math.round(

              Number(

                transaction.confidence ||

                  0

              ) * 100

            )}

            %

          </strong>



        </div>





        <div className="review-grid">



          <div className="form-group">



            <label>

              Type

            </label>



            <select

              value={

                transaction.type ||

                "sale"

              }

              onChange={(event) =>

                update(

                  "type",

                  event.target.value

                )

              }

            >



              <option value="sale">

                Sale

              </option>



              <option value="purchase">

                Purchase

              </option>



              <option value="expense">

                Expense

              </option>



            </select>



          </div>





          <div className="form-group">



            <label>

              Item

            </label>



            <input

              value={

                transaction.item ||

                ""

              }

              onChange={(event) =>

                update(

                  "item",

                  event.target.value

                )

              }

            />



          </div>





          <div className="form-group">



            <label>

              Quantity

            </label>



            <input

              type="number"

              value={

                transaction.quantity ??

                ""

              }

              onChange={(event) =>

                update(

                  "quantity",

                  event.target.value

                )

              }

            />



          </div>





          <div className="form-group">



            <label>

              Unit

            </label>



            <input

              value={

                transaction.unit ||

                ""

              }

              onChange={(event) =>

                update(

                  "unit",

                  event.target.value

                )

              }

            />



          </div>





          <div className="form-group">



            <label>

              Price per unit

            </label>



            <input

              type="number"

              value={

                transaction.pricePerUnit ??

                ""

              }

              onChange={(event) =>

                update(

                  "pricePerUnit",

                  event.target.value

                )

              }

            />



          </div>





          <div className="form-group">



            <label>

              Total amount

            </label>



            <input

              type="number"

              value={

                transaction.totalAmount ??

                ""

              }

              onChange={(event) =>

                update(

                  "totalAmount",

                  event.target.value

                )

              }

            />



          </div>





          <div className="form-group review-full">



            <label>

              Customer / Supplier

            </label>



            <input

              value={

                transaction.counterparty ||

                ""

              }

              onChange={(event) =>

                update(

                  "counterparty",

                  event.target.value

                )

              }

            />



          </div>



        </div>





        {error && (

          <div className="form-error">

            {error}

          </div>

        )}





        <div className="modal-actions">



          <button

            className="cancel-button"

            onClick={onClose}

            disabled={saving}

          >

            Discard

          </button>



          <button

            className="save-button"

            onClick={save}

            disabled={

              saving ||

              !transaction.item?.trim()

            }

          >

            {saving

              ? "Saving..."

              : "Confirm & save"}

          </button>



        </div>



      </div>



    </div>

  );

}





export default App;
